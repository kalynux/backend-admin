import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { PERMISSION_CATALOG, PermissionName } from '../../authorization/domain/permission.catalog';
import { PERMISSION_FAMILIES } from '../../authorization/domain/permission.types';
import { AUDIT_TARGET_TYPES, AuditTargetType, AuditTransport } from './audit.types';

/**
 * Every action the audit trail can record, and how.
 *
 * ── Why a closed registry rather than free strings ────────────────────────────
 * `approval.service.ts:332-338` already pays the cost of the alternative: it stores an
 * action as a string and has to refuse, at read time, a row whose action the catalog no
 * longer knows. A closed union avoids that entirely, and buys two more things — `action`
 * becomes a pinned `z.enum` on the query (ADR-005 D-17: the vocabulary is ours), and the
 * dashboard builds its filter from `GET /audit/actions` instead of discovering the
 * vocabulary by collecting 400s.
 *
 * ── The relationship to the permission catalog ────────────────────────────────
 * Where an action is governed by a permission, it REUSES that permission's name. That is
 * deliberate: `administrators.suspend` means one thing, and having an audit name that
 * merely resembles the permission name is how the two drift. `permission: null` marks the
 * actions no permission governs — identity events, which every administrator performs on
 * themselves by definition, and system work nobody requested.
 *
 * `transport` is not documentation. It is what `assertAuditCatalogValid()` and the writer
 * check against, so an action declared `wi_admin_txn` cannot be recorded through the
 * intent→outcome path and vice versa: the mode is a property of the action, decided once
 * here, not a choice each call site re-makes.
 */

export interface AuditActionSpec {
    /** The permission that governs performing this, or null where none does. */
    permission: PermissionName | null;
    target: AuditTargetType;
    transport: AuditTransport;
    /** One line, shown by `GET /audit/actions`. Written for an administrator. */
    summary: string;
}

export const AUDIT_CATALOG = Object.freeze({
    // ═══ ADMINISTRATORS — this service's own accounts ═════════════════════════
    // Every one is `wi_admin_txn`: the account row and its audit row commit together,
    // so an administrator cannot be created, promoted or suspended unauditably.

    'administrators.create': {
        permission: 'administrators.create',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Created an administrator account',
    },
    'administrators.update': {
        permission: 'administrators.update',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: "Edited another administrator's profile",
    },
    /**
     * Distinct from `administrators.update` although both call `updateProfile`. Editing
     * your own display name is not an administrative act over an account, which is why
     * the route is `selfService` — and a feed that cannot tell the two apart makes
     * "who edited this person's record" unanswerable.
     */
    'administrators.profile.update_self': {
        permission: null,
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Edited their own profile',
    },
    'administrators.suspend': {
        permission: 'administrators.suspend',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Suspended an administrator',
    },
    /**
     * Its own name, though it shares the `administrators.suspend` permission and the
     * same dual-control handler. Two opposite acts under one label make a feed
     * unreadable — and reinstatement is precisely the act that erases the suspension
     * columns (`applyReinstatement`), so it is the one that most needs its own row.
     */
    'administrators.reinstate': {
        permission: 'administrators.suspend',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Reinstated a suspended administrator',
    },
    'administrators.tier.set': {
        permission: 'administrators.tier.set',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: "Changed an administrator's level",
    },
    /**
     * Its own action, not folded into `administrators.password.reset`.
     *
     * They remove different controls — one the thing you know, the other the thing you
     * have — and an account review needs to see which was cleared and when. A single label
     * would also hide the case that matters most: both, in quick succession, by one actor.
     */
    'administrators.mfa.reset': {
        permission: 'administrators.mfa.reset',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Cleared another administrator’s two-factor enrolment',
    },
    'administrators.password.reset': {
        permission: 'administrators.password.reset',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: "Reset another administrator's password",
    },
    /**
     * Letting somebody in — the act that turns a `pending` administrator into a working one
     * (ADR-023 D-1).
     *
     * Its own action rather than a flavour of `administrators.update`, for the reason
     * `reinstate` is separate from `suspend`: they are opposite acts on the same column, and a
     * feed that cannot tell "was admitted" from "was edited" cannot answer the one question
     * this trail is opened for — *when did this person get access, and who decided*.
     *
     * ⚠ Deliberately NOT reused for reinstatement, which lifts a suspension and is a different
     * decision with a different permission and a dual-control rule of its own.
     */
    'administrators.activate': {
        permission: 'administrators.activate',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Activated a pending administrator',
    },

    // ═══ EMPLOYEE RECORDS ═════════════════════════════════════════════════════
    //
    // ⚠ **Every payload here names the KEYS that changed and never their VALUES**, and that is
    // the rule the whole section is built on (ADR-023 D-8). `audit.read` reaches tier 3,
    // narrowed per row by `auditScopeFilter`; a `before`/`after` carrying a salary, a date of
    // birth or a mother's maiden name would route this record's contents into a feed it is
    // specifically withheld from. That the ACTOR is tier 1 does not help — the ROW's audience
    // is not the actor's.
    //
    // The trail still answers what a trail is for: who changed what field, when.

    /**
     * The employee maintaining their own record. `permission: null` — it is self-service, and
     * every administrator does it on themselves by definition.
     */
    'employees.record.update_self': {
        permission: null,
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Updated their own employee record',
    },
    /**
     * ⚠ `external`, not `wi_admin_txn`: the bytes land in jovi-mall's storage and its
     * database, which no `wi-admin` ClientSession can join. Recorded as an ATTEMPT before the
     * body is streamed, fail-closed — with the audit store down, no identity document is
     * stored.
     */
    'employees.documents.upload': {
        permission: null,
        target: 'administrator',
        transport: 'external',
        summary: 'Uploaded an identity document to their own employee record',
    },
    /** Filing an uploaded document into a slot — a `wi-admin` write, unlike the upload itself. */
    'employees.documents.attach': {
        permission: null,
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Filed an identity document into a slot on their own record',
    },
    'employees.documents.detach': {
        permission: null,
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Removed an identity document from their own record',
    },
    'employees.avatar.set': {
        permission: null,
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Changed their own profile picture',
    },
    /**
     * The one write on this record performed BY somebody else ABOUT the employee: position,
     * contract terms, monthly salary.
     *
     * The only entry in this section with a permission, and that asymmetry is the section's
     * shape in one line — an employee states their own facts, the company states its terms.
     */
    'employees.employment.update': {
        permission: 'employees.employment.write',
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: "Set an administrator's position, contract terms or salary",
    },

    /** Redis, not Mongo — see the `external` transport note in `audit.types.ts`. */
    'administrators.sessions.revoke': {
        permission: 'administrators.sessions.revoke',
        target: 'administrator',
        transport: 'external',
        summary: "Signed an administrator out of every device",
    },
    'administrators.sessions.revoke_one': {
        permission: 'administrators.sessions.revoke',
        target: 'admin_session',
        transport: 'external',
        summary: "Ended one of an administrator's sessions",
    },

    // ═══ AUTHENTICATION — identity events ═════════════════════════════════════
    // Named `administrators.auth.*`, not `auth.*`. There is no `auth` permission family —
    // the auth routes are public or self-service — and the boot assertion refuses a family
    // that is not one, which is how this section got its name. It is also the truer
    // grouping: these are events about administrator ACCOUNTS, so they belong to the
    // family that owns them and inherit its `internal` subject class, keeping them out of
    // a Support administrator's feed.
    //
    // `observation` transport: nothing to roll back, so nothing to refuse. Recorded
    // best-effort, because a hard line here would make an audit-store outage a lockout
    // with no way in to fix it — and `session.service.ts` already made exactly this call
    // for exactly this data.

    'administrators.auth.login_succeeded': {
        permission: null, target: 'administrator', transport: 'observation',
        summary: 'Signed in',
    },
    'administrators.auth.login_failed': {
        permission: null, target: 'administrator', transport: 'observation',
        summary: 'A sign-in attempt failed',
    },
    'administrators.auth.lockout_engaged': {
        permission: null, target: 'administrator', transport: 'observation',
        summary: 'An account was locked after repeated failures',
    },
    'administrators.auth.mfa_failed': {
        permission: null, target: 'administrator', transport: 'observation',
        summary: 'A two-factor code was rejected',
    },
    /**
     * The single highest-value row in the log. A superseded refresh token being presented
     * is not a mistake a client makes — `admin-auth.service.ts` treats it as proof the
     * credential is loose and destroys the whole session. Alert on this one.
     */
    'administrators.auth.refresh_reuse_detected': {
        permission: null, target: 'administrator', transport: 'observation',
        summary: 'A superseded refresh token was replayed — the session was destroyed',
    },
    // These three write to the account row, so they are state changes, not observations.
    'administrators.auth.mfa_enrolled': {
        permission: null, target: 'administrator', transport: 'wi_admin_txn',
        summary: 'Started two-factor enrolment',
    },
    'administrators.auth.mfa_activated': {
        permission: null, target: 'administrator', transport: 'wi_admin_txn',
        summary: 'Activated two-factor authentication',
    },
    'administrators.auth.password_changed': {
        permission: null, target: 'administrator', transport: 'wi_admin_txn',
        summary: 'Changed their own password',
    },
    /**
     * The administrator's own CONTACT phone — set, and proved.
     *
     * ⚠ Neither is a login event, and the distinction matters for anybody reading this trail
     * during an incident: administrators authenticate with a password and TOTP, and nothing in
     * the auth path reads `phone_verified`. A row here means the platform learned how to REACH
     * somebody, not that anything about their access changed.
     *
     * `phone_set` records because it silently un-verifies a number that was previously proved;
     * the request that sends a code deliberately records nothing, since a resend is routine and
     * would bury the outcome below it.
     */
    'administrators.profile.phone_set': {
        permission: null, target: 'administrator', transport: 'wi_admin_txn',
        summary: 'Set their own contact phone number',
    },
    'administrators.profile.phone_verified': {
        permission: null, target: 'administrator', transport: 'wi_admin_txn',
        summary: 'Verified their own contact phone number',
    },

    'administrators.auth.logout': {
        permission: null, target: 'administrator', transport: 'external',
        summary: 'Signed out',
    },
    'administrators.auth.logout_all': {
        permission: null, target: 'administrator', transport: 'external',
        summary: 'Signed out of every device',
    },
    'administrators.auth.session_revoked': {
        permission: null, target: 'admin_session', transport: 'external',
        summary: 'Ended one of their own sessions',
    },
    /**
     * Every session cut by the SYSTEM rather than by a person — the suspended-account
     * branch of a token refresh, and the authentication gate that finds a suspended
     * administrator mid-session.
     *
     * Distinct from `logout_all`, which the administrator asks for. This one happens TO
     * them, and it is the only evidence that a suspension took effect on live sessions
     * rather than merely setting a column: `administrators.suspend` records the decision,
     * this records the eviction.
     */
    /**
     * The password was accepted and a second factor is now required.
     *
     * It pairs with `mfa_failed` to distinguish the two situations a security review most
     * needs told apart: somebody guessing passwords (a run of `login_failed`), and somebody
     * who ALREADY HAS a working password and is now attacking the second factor (a run of
     * these, or of these followed by `mfa_failed`). Before Phase 12 the second case was a
     * `log.info` and appeared in the trail as nothing.
     */
    'administrators.auth.mfa_challenged': {
        permission: null, target: 'administrator', transport: 'observation',
        summary: 'Password accepted — a two-factor code was requested',
    },
    'administrators.auth.session_terminated': {
        permission: null, target: 'administrator', transport: 'observation',
        summary: 'Their sessions were ended because the account is suspended',
    },

    // ═══ APPROVALS — four eyes ════════════════════════════════════════════════
    // The action an approval PERFORMS is audited separately, by its own normal path,
    // carrying `via_approval_id`. These rows record the decision, not the write.
    //
    // ── There is no `approvals.requested`, deliberately ──────────────────────
    // It was declared here from Phase 3.5 and never written by anything. Phase 12 removed
    // it rather than wiring it, because the row it would write already exists: queueing
    // goes through `auditedQueue`, which records the QUEUED ACTION ITSELF at
    // `status: 'queued'`, re-targeted at the approval request. That row already says who
    // asked, for what, and against which target — naming the act (`administrators.tier.set`)
    // rather than the generic fact that something was submitted.
    //
    // Two rows per request would also have made the feed lie by counting: every queued
    // action would appear twice, once as itself and once as `approvals.requested`.

    'approvals.approved': {
        permission: 'approvals.read', target: 'approval_request', transport: 'wi_admin_txn',
        summary: 'Approved another administrator’s request',
    },
    'approvals.rejected': {
        permission: 'approvals.read', target: 'approval_request', transport: 'wi_admin_txn',
        summary: 'Rejected another administrator’s request',
    },
    'approvals.withdrawn': {
        permission: null, target: 'approval_request', transport: 'wi_admin_txn',
        summary: 'Withdrew their own request',
    },
    'approvals.expired': {
        permission: null, target: 'approval_request', transport: 'wi_admin_txn',
        summary: 'A request expired undecided',
    },

    // ═══ COD — delegated to jovi-mall ═════════════════════════════════════════
    // Three mutations, not five: the two list endpoints are reads and reads are not
    // audited. `delegated` — the write lands in jovi-mall's transaction, which a
    // `wi-admin` session cannot join, so intent→outcome and a dangling `attempted` row
    // is resolved by grepping jovi-mall for the same correlation id.

    'cod.remittances.confirm': {
        permission: 'cod.remittances.confirm', target: 'remittance', transport: 'delegated',
        summary: 'Confirmed an agency cash remittance',
    },
    'cod.remittances.reject': {
        permission: 'cod.remittances.reject', target: 'remittance', transport: 'delegated',
        summary: 'Rejected an agency remittance declaration',
    },
    'cod.deposits.confirm': {
        permission: 'cod.deposits.confirm', target: 'deposit', transport: 'delegated',
        summary: 'Confirmed an agent cash deposit',
    },
    'cod.deposits.create': {
        permission: 'cod.deposits.create', target: 'deposit', transport: 'delegated',
        summary: 'Recorded cash paid directly to the platform by an agent',
    },
    'cod.deposits.reject': {
        permission: 'cod.deposits.reject', target: 'deposit', transport: 'delegated',
        summary: 'Rejected a recorded cash deposit',
    },
    'cod.discrepancies.resolve': {
        permission: 'cod.discrepancies.resolve', target: 'discrepancy', transport: 'delegated',
        summary: 'Resolved a cash discrepancy, deciding who absorbs the shortfall',
    },
    /**
     * Targets the AGENT, not a discrepancy or a deposit.
     *
     * The trust score lives on `delivery_agents` and bounds how much cash that person may
     * carry, so the subject of the act is the agent — and this is the row that has to turn
     * up on `/agents/:id/activity` when somebody asks why their ceiling moved. A
     * `cod_trust_event` target type would be more literal and would file the row where
     * nobody looks for it.
     */
    'cod.trust.adjust': {
        permission: 'cod.trust.adjust', target: 'agent', transport: 'delegated',
        summary: "Manually adjusted an agent's cash trust score",
    },

    // ═══ AGENTS — delegated to jovi-mall ══════════════════════════════════════
    // Seven mutations. The six reads — list, detail, contracts, contract history,
    // tracking policy, COD allocation, eligibility — are not here: a list and a detail
    // are not actions.
    //
    // All `delegated`: every one of these lands in jovi-mall, and each is load-bearing
    // there in a way flipping the column from here would not reproduce. `kyc.status`
    // decides whether the agent may be dispatched at all (`assertEligible` passes only on
    // `verified`); `platform_ban` is consulted by every gate; `cod.max_threshold` bounds a
    // shared pool whose sub-allocation must stay transactional.

    'agents.status.set': {
        permission: 'agents.status.set',
        target: 'agent',
        transport: 'delegated',
        summary: 'Changed an agent’s account status',
    },
    'agents.kyc.review': {
        permission: 'agents.kyc.review',
        target: 'agent',
        transport: 'delegated',
        summary: 'Reviewed an agent’s identity documents — this is what lets an agent work',
    },
    /**
     * The `after` on this row is the only durable record of what an administrator
     * intended, because the flag itself is a single boolean. Worth reading with the
     * boundary in mind: disabling stops *new* dispatch immediately (`assertEligible`) and,
     * since Phase 9, is pushed to geo-tracker, which suppresses the live position. It does
     * not revoke a watcher — `visible-agents` does not consult the flag — so an agency
     * watching stays subscribed and receives nothing.
     */
    'agents.tracking.set': {
        permission: 'agents.tracking.set',
        target: 'agent',
        transport: 'delegated',
        summary: 'Changed whether an agent may be tracked',
    },
    'agents.cod_threshold.set': {
        permission: 'agents.cod_threshold.set',
        target: 'agent',
        transport: 'delegated',
        summary: 'Set how much cash on delivery an agent may hold before remitting',
    },
    'agents.ban': {
        permission: 'agents.ban',
        target: 'agent',
        transport: 'delegated',
        summary: 'Banned an agent from the platform',
    },
    /**
     * Its own name although it shares the `agents.ban` permission — the same reasoning as
     * `users.reinstate`, and here it is sharper. Lifting a ban CLEARS `platform_ban.reason`,
     * `banned_at` and the actor stamp off the agent row, so this row is the only surviving
     * record that the ban happened. Two opposite acts under one label would also make the
     * one screen that matters — an agent's history — unreadable.
     */
    'agents.unban': {
        permission: 'agents.ban',
        target: 'agent',
        transport: 'delegated',
        summary: 'Lifted an agent’s platform ban',
    },
    /**
     * The two audited READS added at Phase 6.I — and the second and third exceptions in
     * this catalog to "reads are not actions", argued on the same grounds as the first.
     *
     * `money.payouts.destination.read` breaks that rule because its output is the material
     * a fraudulent payout instruction is built from. These break it because their output is
     * **a person's location**, read by an administrator that person has no relationship
     * with. For a disclosure the interesting question is not who MAY but who DID: an
     * administrator who unmasks forty positions in an afternoon is doing something other
     * than answering tickets, and nothing else in this service would ever see it.
     *
     * `external`, not `observation`, and the difference is the whole design. `observation`
     * is best-effort and swallows a write failure — right for a login, which happened on
     * its own terms; wrong here, where **the audit row IS the control**. `auditedAttempt`
     * commits the intent first and does not catch, so with the audit store unreachable the
     * disclosure simply never runs. That posture is what makes granting the permission to
     * Support defensible.
     *
     * ── Why two actions, in two families ──────────────────────────────────────
     * Their TARGETS differ, and the target is the column an operator searches. "Who looked
     * at where this agent is" and "who pulled this delivery's trail" are different
     * questions, and one action would make the first unanswerable for any read that went
     * through the shipment door.
     *
     * They also hold two different permissions, and that is `assertAuditCatalogValid()`'s
     * doing rather than a first draft: it refused a `shipments.*` action governed by an
     * `agents.*` permission, and the rule was right about more than naming. The split
     * (`agents.tracking.read` / `shipments.tracking.read`) lines this up with geo-tracker's
     * own scope model, which separates `agent:position` from `shipment:trail` for the same
     * reason — live surveillance of a person is not the same exposure as a case file about
     * a delivery, and an operator should be able to grant them apart.
     *
     * Neither row carries coordinates. It records THAT a location was disclosed, the
     * subject, and the stated reason — putting the values in would move a person's
     * position into the one store readable without the permission gating it, and the audit
     * trail would become the leak. Same rule the payout disclosure follows.
     */
    'agents.tracking.position.read': {
        permission: 'agents.tracking.read',
        target: 'agent',
        transport: 'external',
        summary: 'Read an agent’s live position from geo-tracker',
    },
    'shipments.tracking.trail.read': {
        permission: 'shipments.tracking.read',
        target: 'shipment',
        transport: 'external',
        summary: 'Read a delivery’s GPS trail from geo-tracker',
    },
    'agents.transfer': {
        permission: 'agents.transfer',
        target: 'agent',
        transport: 'delegated',
        summary: 'Moved an agent from one delivery agency to another',
    },
    /**
     * Three names, one permission, for the reason `agents.ban`/`agents.unban` are two:
     * a single label makes the trail say "somebody did something to a contract" and
     * forces every reader to open the row to learn which direction it went. Suspending
     * and reinstating are opposite acts and the difference is the whole content.
     *
     * `target: 'agent'` although the subject is a contract: the audit target vocabulary
     * has no `contract` member, and the agent is the party whose livelihood this affects
     * — which is the record a reviewer will search by.
     */
    'agents.contracts.suspend': {
        permission: 'agents.contracts.manage',
        target: 'agent',
        transport: 'delegated',
        summary: 'Froze one agent↔agency contract — no new assignments, terms untouched',
    },
    'agents.contracts.reinstate': {
        permission: 'agents.contracts.manage',
        target: 'agent',
        transport: 'delegated',
        summary: 'Unfroze one agent↔agency contract',
    },
    /**
     * ⚠ The one action on this surface that routinely does NOT do what its name says,
     * and the row records that honestly. Deactivation needs the counterparty's agreement
     * and the outstanding COD and agent payment cleared, so the outcome is often a
     * pending request rather than a terminated contract. The `after` carries which.
     */
    'agents.contracts.terminate': {
        permission: 'agents.contracts.manage',
        target: 'agent',
        transport: 'delegated',
        summary: 'Asked to end one agent↔agency contract (completes only once the balances are clear)',
    },

    // ═══ SUPPORT TICKETS — delegated to jovi-mall (Phase 17) ══════════════════
    //
    // Every one is `delegated`: jovi-mall creates tickets in-process from the payout,
    // dispute and booking-refund paths and publishes on its in-process event bus for each
    // write, so this service could neither own the collection nor write it without silently
    // dropping the customer's notification.
    //
    // Reads are not here, and that is ADR-006 D-5 — a ticket read moves nothing. The one
    // audited read on this whole service remains the payout destination, where the
    // disclosure IS the action.

    'support.tickets.create': {
        permission: 'support.tickets.create',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Opened a support ticket on somebody’s behalf',
    },
    'support.tickets.update': {
        permission: 'support.tickets.update',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Edited a ticket’s subject or description',
    },
    'support.tickets.status.set': {
        permission: 'support.tickets.update',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Moved a ticket to a new status',
    },
    'support.tickets.priority.set': {
        permission: 'support.tickets.update',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Changed a ticket’s priority — which locks it to administrators thereafter',
    },
    /**
     * Handing over and claiming are two actions on one endpoint, and they stay two.
     *
     * "Gave this ticket to X" and "took this ticket" read differently six months later, and
     * only the first names another person. Same reasoning as `agencies.deactivate` and
     * `agencies.reactivate`, which also share a shape and not a name.
     */
    'support.tickets.assign': {
        permission: 'support.tickets.assign',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Handed a ticket to another administrator',
    },
    'support.tickets.claim': {
        permission: 'support.tickets.assign',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Claimed an unassigned ticket from the pool',
    },
    'support.tickets.close': {
        permission: 'support.tickets.lifecycle',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Closed a ticket',
    },
    'support.tickets.reopen': {
        permission: 'support.tickets.lifecycle',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Reopened a closed ticket',
    },
    'support.tickets.followers.add': {
        permission: 'support.tickets.followers.manage',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Added a follower to a ticket',
    },
    'support.tickets.followers.remove': {
        permission: 'support.tickets.followers.manage',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Removed a follower from a ticket',
    },
    /**
     * The note's TEXT is deliberately absent from the row's payload — see the gateway. It is
     * staff commentary on somebody's support case, the note itself is the durable record, and
     * copying it here duplicates personal data into a store with a different retention rule.
     */
    'support.tickets.notes.create': {
        permission: 'support.tickets.notes.write',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Added a note to a ticket',
    },
    'support.tickets.attachments.attach': {
        permission: 'support.tickets.attachments.write',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Attached an uploaded file to a ticket',
    },
    'support.tickets.attachments.delete': {
        permission: 'support.tickets.attachments.write',
        target: 'ticket',
        transport: 'delegated',
        summary: 'Deleted a ticket attachment',
    },

    // ═══ CONTENT — written DIRECTLY, and still not transactional ══════════════
    //
    // The only family on this service whose writes land in `jovi_mall` through this
    // service's own connection rather than over HTTP. Ownership of `articles` and
    // `article_authors` moved here at Phase 5 Part A (ADR-004 D-4), because jovi-mall's
    // blog had no in-process subscribers and no non-admin writer — the two properties
    // tickets lack, which is why tickets stayed delegated.
    //
    // ⚠ **`external`, not `wi_admin_txn`, and the distinction is the whole point.**
    // Owning a collection in another database is not the same as owning a collection.
    // `connections.ts` opens TWO MongoClients, so a write to `jovi_mall` is outside any
    // `wi-admin` session and cannot join the transaction an audit row commits in. These go
    // through `auditedAttempt` — intent first, outcome after — exactly as a delegated
    // family does, and a crash between the two leaves the same resolvable dangling intent.
    // The only thing ownership bought was the absence of an HTTP hop.
    //
    // `target: 'article'` for the authors too, matching the way every `support.tickets.*`
    // action targets `ticket` whether it touched a note, a follower or an attachment: the
    // target is the thing an operator would search for, not the row that changed.

    'content.articles.create': {
        permission: 'content.articles.write',
        target: 'article',
        transport: 'external',
        summary: 'Created an article draft',
    },
    'content.articles.update': {
        permission: 'content.articles.write',
        target: 'article',
        transport: 'external',
        summary: 'Edited an article',
    },
    /**
     * Publish, unpublish and archive are **three actions on one permission**, and they are
     * three rows rather than one for the reason `agencies.deactivate` / `.reactivate` are:
     * they are opposite acts with different consequences, and a feed that cannot tell them
     * apart cannot answer "when did this go live".
     *
     * Archive is not a stronger unpublish. An archived URL answers `410 Gone` with its
     * category hub; a drafted one simply 404s. Losing that distinction in the trail loses
     * the only record of which one an operator chose.
     */
    'content.articles.publish': {
        permission: 'content.articles.publish',
        target: 'article',
        transport: 'external',
        summary: 'Published an article — this is what the public sees',
    },
    'content.articles.unpublish': {
        permission: 'content.articles.publish',
        target: 'article',
        transport: 'external',
        summary: 'Pulled a published article back to draft',
    },
    'content.articles.archive': {
        permission: 'content.articles.publish',
        target: 'article',
        transport: 'external',
        summary: 'Retired an article — its URL now answers 410 with its category',
    },
    /**
     * A **soft** delete, and only of an article that was never published.
     *
     * The permission is flagged `destructive` and its catalogued summary used to promise a
     * permanent removal. It is neither permanent nor reachable for a live article: the
     * service refuses outright once `published_at` is set, because an address that has been
     * live may have inbound links and the remedy for those is `archive`.
     */
    'content.articles.delete': {
        permission: 'content.articles.delete',
        target: 'article',
        transport: 'external',
        summary: 'Deleted an unpublished article draft',
    },
    'content.authors.create': {
        permission: 'content.authors.write',
        target: 'article',
        transport: 'external',
        summary: 'Created an article byline',
    },
    'content.authors.update': {
        permission: 'content.authors.write',
        target: 'article',
        transport: 'external',
        summary: 'Edited an article byline',
    },
    /**
     * Refused while any article credits the byline, so this row only ever appears for one
     * nothing points at — which is what keeps every published article's `author` node whole.
     */
    'content.authors.delete': {
        permission: 'content.authors.delete',
        target: 'article',
        transport: 'external',
        summary: 'Deleted an unused article byline',
    },

    // ═══ FILES — delegated to jovi-mall ══════════════════════════════════════
    //
    // Three actions for seven routes, and the four silences are each a decision.
    //
    // ⚠ This header read "one action for three routes" until BR-011, and was already wrong
    // by one when BR-015 arrived — a count in a comment beside a table that grows. It is
    // stated as a RULE below rather than a number, so the next addition does not have to
    // remember to come back here.
    //
    // The rule: a READ on this mount is audited only when **the output IS the disclosure**
    // (ADR-006 D-5's exception test). `files.content.read` passes it — the bytes of a
    // delivery proof are the disclosure. `files.resolve`, `/orphans` and the media library
    // all fail it: they answer a name, a size and an owner, which is metadata about a record
    // the caller was already entitled to reach. The media library ENUMERATES, and the
    // dashboard argued that alone should earn a row; that was weighed and declined (L-5,
    // ADR-021 D-6) — `/orphans` already enumerates here unaudited, and auditing a browse
    // surface dilutes the trail rather than deepening it.
    //
    // Every WRITE is audited, without an argument to have: the delete because it is
    // unrecoverable, the upload because it creates a record and this service audits writes.

    /**
     * A hard delete: the row goes, then the object goes from storage.
     *
     * jovi-mall performs the storage half BEST-EFFORT and treats its own database as the
     * source of truth, so a storage failure leaves the row deleted and logs rather than
     * rolling back. Worth knowing when reading this row back: a succeeded outcome means the
     * record is gone, not that the bytes are.
     *
     * `target: 'file'` rather than `none` because this addresses exactly one record and the id
     * is the only handle anybody has on it afterwards — see `audit.types.ts` at that entry. The
     * payload carries the projection the operator was shown before they confirmed
     * (`originalName`, `mimeType`, `size`, `ownerType`), because after the delete there is
     * nothing left to look the file up in.
     */
    'files.delete': {
        permission: 'files.delete',
        target: 'file',
        transport: 'delegated',
        summary: 'Permanently deleted an uploaded file — unrecoverable',
    },

    /**
     * Opening a file's contents — **the second audited READ on this service's file
     * surface, and the fourth overall** (BR-011).
     *
     * ── Why a read is audited at all ──────────────────────────────────────────
     * "Reads are not actions" (ADR-006 D-5) holds everywhere else and for a good reason:
     * a read leaves no state to reconstruct, so the permission gate is the whole control.
     * The exceptions are all the same shape — **the output IS the disclosure** — and this
     * is one of them. A delivery-proof photograph is a place, a time, usually a residence
     * and sometimes a person, read by an administrator that person has no relationship
     * with; a `digital/` file is a vendor's saleable product. For a disclosure, "who may"
     * is not the interesting question. "Who did, and how often" is — an administrator
     * opening forty proof photos in an afternoon is doing something other than answering
     * tickets, and nothing else here would ever see it.
     *
     * That is not abstract: `files.content.read` is held by **tier 3 (Support)**,
     * deliberately, and this row is the other half of that decision. Same trade, same
     * shape, as `agents.tracking.read`.
     *
     * ── `auditedAttempt`, and the ordering IS the control ─────────────────────
     * `transport: 'delegated'` — the bytes come from jovi-mall, so no `wi-admin`
     * ClientSession can span the two. The intent commits FIRST and its failure is not
     * caught, so with the audit store unreachable nothing is disclosed. A crash between
     * the intent and the answer leaves a row at `attempted`, which read conservatively
     * means the file may have been disclosed.
     *
     * ── What the row does NOT contain ─────────────────────────────────────────
     * **No bytes, and no storage key.** It records THAT a file was opened, which file, and
     * what it turned out to be (`mimeType`, `size`). Putting content anywhere near the
     * audit store would make the trail itself the leak — the rule `payout-disclosure.ts`
     * follows for account numbers and `tracking-disclosure.ts` follows for coordinates.
     * The key is withheld for the separate D-10 reason: it is an internal locator that
     * names the owner's tree and adds nothing to the record.
     *
     * ⚠ **Audited HERE and deliberately not in jovi-mall**, which is where the bytes
     * actually live. That service authenticates a *service*, not a person — `X-Actor-Id`
     * reaches it and is advisory by construction, since whoever holds the token could set
     * it — so a row written there would attribute a disclosure to an unverifiable string.
     * This is where the human is known. Same reasoning as ADR-020 D-5.
     */
    'files.content.read': {
        permission: 'files.content.read',
        target: 'file',
        transport: 'delegated',
        summary: 'Opened an uploaded file’s contents',
    },

    /**
     * Putting a file ON the platform — the first write of its kind here (BR-015).
     *
     * ── Why it needs no argument, unlike the read above ───────────────────────
     * It is a write. ADR-006 D-5's "reads are not actions" is the rule that needed the
     * exception test; a write is on the other side of it by definition. What makes this one
     * worth a note is not whether to record it but **what the row is FOR**.
     *
     * ── The row is the only place the administrator is named ──────────────────
     * The file lands in jovi-mall stamped `ownerType: 'admin'`, `ownerId: <X-Actor-Id>` —
     * a `wi_admin.admin_accounts._id` written into a column jovi-mall declares
     * `ref: MODELS.USER`, where it resolves to nothing (ADR-004 D-1). jovi-mall audits
     * nothing on this path and cannot: it authenticates a *service*, and `X-Actor-Id` is a
     * header the token holder sets. So the trail on this side is not corroboration of a
     * record kept elsewhere — it is the record. Same reasoning as ADR-020 D-5, and the same
     * as `files.content.read` above.
     *
     * ── `auditedAttempt`, intent → outcome ───────────────────────────────────
     * `transport: 'delegated'`: the bytes and the row land in jovi-mall's database over
     * HTTP, which no `wi-admin` ClientSession can join. The intent commits BEFORE the body
     * is streamed, so an upload that crashed mid-transfer leaves an `attempted` row — read
     * conservatively, that means a file may exist. That is the honest reading: jovi-mall
     * writes the `files` row only after the whole body arrives and the pipeline passes, but
     * this service cannot see which side of that line a broken connection fell on.
     *
     * ⚠ **`target: 'file'` with `id: null` on the intent**, filled from the outcome. The
     * id does not exist until jovi-mall has created it, and a row addressed to a
     * placeholder would be worse than one addressed to nothing. The `after` payload carries
     * the created ids, the byte counts and the resolved MIME types — never the CONTENT,
     * which is the same rule the content read follows for the same reason: putting bytes
     * near the audit store makes the trail the leak.
     */
    'files.upload': {
        permission: 'files.upload',
        target: 'file',
        transport: 'delegated',
        summary: 'Uploaded a file to the platform as the administration',
    },

    // ═══ MESSAGING — delegated to jovi-mall ══════════════════════════════════
    //
    // One action, one route. Renamed from the `broadcast` family at Phase 5 Part C, and
    // the rename is the substance: nothing here fans out.

    /**
     * One Telegram message to one connected account.
     *
     * ⚠ **The only action on this service that is un-undoable in the strongest sense.**
     * `files.delete` is unrecoverable — the record is gone and nobody was told anything.
     * This one has already been READ by the time an operator reconsiders it, and there is
     * no delivery record anywhere to reconstruct it from: jovi-mall's `sendMessage` returns
     * a boolean and keeps nothing. So this row IS the record of the send, which is why it
     * carries the full message body alongside the recipient (Phase 5 O-2). The credential
     * redaction and the payload size cap still apply; `message` is not a redacted field
     * name, so what the operator typed is what the trail keeps.
     *
     * `target: 'user'` in both addressing forms. When the operator named a `userId` that is
     * the target id; when they named a raw Telegram `chatId` the id is null and the label
     * carries `telegram:<chat>` — a chat id addresses a person, so the type is honest
     * either way and only the searchable column differs. `none` was the alternative and is
     * worse for the same reason it was rejected at `files.delete`: it moves the only handle
     * on the recipient into the payload.
     *
     * That classifies as `platform_actor`, so Support can READ this row while holding no
     * permission to perform the send (tiers 1-2). Deliberate, and the same trade-off the
     * file delete carries: seeing that an administrator messaged a customer whose ticket
     * they are working is the point of the class.
     *
     * `transport: 'external'` — the send happens in jovi-mall's process, which no `wi-admin`
     * ClientSession can join. Intent → outcome, with the resolved chat stamped on the way
     * out.
     */
    'messaging.telegram.send': {
        permission: 'messaging.telegram.send',
        target: 'user',
        transport: 'external',
        summary: 'Sent a Telegram message to a connected account',
    },

    // ═══ AGENCIES — delegated to jovi-mall ════════════════════════════════════
    // Three mutations. Deactivation is the one whose delegation is least optional: it
    // suspends every vendor product defaulting to that agency and holds their order items,
    // in one transaction paired with post-commit events. A second writer would get the
    // rows right and the notifications silently wrong.

    /**
     * The verb this family was missing. Before Phase 9 an agency could only be created at
     * `pending_verification` and had no way out of it except `reactivate` — see the note on
     * the permission. The write is one compare-and-set, so a losing administrator is told
     * the state moved rather than overwriting the winner.
     */
    'agencies.verify': {
        permission: 'agencies.verify',
        target: 'agency',
        transport: 'delegated',
        summary: 'Approved a delivery agency’s business verification',
    },
    /**
     * The refusal, added in Phase 6 Step 4. It shares the `agencies.verify` PERMISSION —
     * one review capability, two verdicts, the same shape as `vendors.kyc.approve` /
     * `vendors.kyc.reject` — and gets its own action here because that is what an
     * administrator later searches the trail by.
     *
     * The reason is in this row's payload AND forwarded to jovi-mall, which stores it on
     * the agency. That is the deliberate exception to `agencies.deactivate` below, whose
     * reason is audit-only: this one is shown to the agency, who cannot read this database.
     */
    'agencies.reject': {
        permission: 'agencies.verify',
        target: 'agency',
        transport: 'delegated',
        summary: 'Refused a delivery agency’s business verification',
    },
    'agencies.deactivate': {
        permission: 'agencies.deactivate',
        target: 'agency',
        transport: 'delegated',
        summary: 'Deactivated a delivery agency and suspended every product defaulting to it',
    },
    /**
     * Its own name although it shares no permission with the above — `agencies.reactivate`
     * is its own permission, unlike the suspend/reinstate pairs. It carries what the
     * restore could NOT bring back: a listing that no longer passes its activation gate
     * stays suspended, and the counts in `after` are where that becomes visible.
     */
    'agencies.reactivate': {
        permission: 'agencies.reactivate',
        target: 'agency',
        transport: 'delegated',
        summary: 'Reactivated a delivery agency and put its dependent products back on sale',
    },

    // ═══ USERS — delegated to jovi-mall ═══════════════════════════════════════
    // The reads are not here: a list and a detail are not actions. Three mutations,
    // all `delegated` — the write lands in jovi-mall, whose transaction a `wi-admin`
    // session cannot join, so intent→outcome.
    //
    // These are the first rows in the trail whose subject is a `platform_actor`, which
    // is the class a Support administrator CAN read (`audit-subject.ts`). That is
    // deliberate: Support holds `users.read`, so seeing what was done to an account they
    // can already look up is the point of the role, not a leak.

    'users.update': {
        permission: 'users.update',
        target: 'user',
        transport: 'delegated',
        summary: 'Changed a user’s login email or phone number',
    },
    'users.suspend': {
        permission: 'users.suspend',
        target: 'user',
        transport: 'delegated',
        summary: 'Suspended a user account',
    },
    /**
     * Its own name although it shares the `users.suspend` permission — the same
     * reasoning as `administrators.reinstate`. Two opposite acts under one label make a
     * feed unreadable, and reinstatement is the act that CLEARS `suspended_reason` and
     * `suspended_by` off the user row, so the audit row is the only surviving record
     * that the suspension ever happened.
     */
    'users.reinstate': {
        permission: 'users.suspend',
        target: 'user',
        transport: 'delegated',
        summary: 'Lifted a user account suspension',
    },
    /**
     * Credential recovery — an administrator acting on somebody else's ability to sign in.
     *
     * ── What the row keeps, and what it must never keep ─────────────────────────
     * The channel, the MASKED destination and the operator's reason. **Never the token,
     * never the link, never the full address.** The audit trail is read by more people
     * than the action was performed by; a link in it is a live credential sitting in a
     * feed, and a full address in it is a delivery target for whoever reads the feed next.
     * The delegated response is already shaped that way — it carries no token — so the
     * `after` cannot accidentally acquire one.
     *
     * Two names, one per credential, and NOT because two permissions govern them (though
     * they do). A reset link grants nothing until the person chooses a password; a
     * sign-in link IS a session. A reviewer scanning the trail must be able to tell those
     * apart without opening the row.
     */
    'users.password_reset_link.send': {
        permission: 'users.password.reset',
        target: 'user',
        transport: 'delegated',
        summary: 'Sent a user a password-reset link',
    },
    'users.login_link.send': {
        permission: 'users.login_link.send',
        target: 'user',
        transport: 'delegated',
        summary: 'Sent a customer a passwordless sign-in link',
    },

    // ═══ VENDORS — delegated to jovi-mall ═════════════════════════════════════
    // Seven mutations. The reads — list, detail, products, activity — are not here: a
    // list and a detail are not actions.
    //
    // All `target: 'vendor'`, including the two that act on a PRODUCT. A `product` target
    // type would have to be classified in `audit-subject.ts` (cheap — that Record is
    // exhaustive), but the vendor activity feed filters on `targetType: 'vendor'`, so a
    // separate type would silently drop every product takedown out of the one feed where
    // an administrator would look for it: "this vendor's listings went dark, why". The
    // product id and title ride in `payload`. Promote it to a real target when a product
    // admin screen exists to read it — not before.

    'vendors.suspend': {
        permission: 'vendors.suspend',
        target: 'vendor',
        transport: 'delegated',
        summary: 'Suspended a vendor and took their listings off sale',
    },
    /**
     * Its own name although it shares the `vendors.suspend` permission — the same
     * reasoning as `users.reinstate`. Reinstatement is the act that CLEARS the reason and
     * the actor stamp off the vendor row, so this row is the only surviving record that
     * the suspension happened. It also carries what the restore could NOT bring back: a
     * listing that no longer passes the activation gate stays suspended, and the counts
     * in `after` are where that becomes visible.
     */
    'vendors.reinstate': {
        permission: 'vendors.suspend',
        target: 'vendor',
        transport: 'delegated',
        summary: 'Lifted a vendor suspension and put their listings back on sale',
    },
    'vendors.kyc.approve': {
        permission: 'vendors.kyc.review',
        target: 'vendor',
        transport: 'delegated',
        summary: 'Approved a vendor’s business verification',
    },
    'vendors.kyc.reject': {
        permission: 'vendors.kyc.review',
        target: 'vendor',
        transport: 'delegated',
        summary: 'Rejected a vendor’s business verification',
    },
    'vendors.products.suspend': {
        permission: 'vendors.products.manage',
        target: 'vendor',
        transport: 'delegated',
        summary: 'Took one of a vendor’s products off sale as platform oversight',
    },
    'vendors.products.restore': {
        permission: 'vendors.products.manage',
        target: 'vendor',
        transport: 'delegated',
        summary: 'Put one of a vendor’s suspended products back on sale',
    },
    'vendors.settings.update': {
        permission: 'vendors.settings.manage',
        target: 'vendor',
        transport: 'delegated',
        summary: 'Changed a vendor’s platform-governed order settings',
    },

    // ═══ ORDERS — delegated to jovi-mall (Phase 10) ═══════════════════════════
    // Four mutations. The reads — a list, a detail, a timeline, an eligibility verdict —
    // are not here: they are not actions.
    //
    // NOTE what is ABSENT, and why. Every other delegated family in this catalog carries
    // an opposite action (`users.reinstate`, `vendors.reinstate`, `agents.unban`) because
    // those writes clear the very columns that record them. Nothing here has one. A
    // cancelled order is not un-cancelled and a refund is not un-refunded — the reversal
    // is a NEW financial act with its own row, not an undo. If a later phase adds one,
    // that is a new capability rather than a missing pair.

    'orders.disputes.resolve': {
        permission: 'orders.disputes.resolve',
        target: 'order',
        transport: 'delegated',
        summary: 'Resolved an order payment dispute, deciding who keeps the money',
    },
    'orders.cancel': {
        permission: 'orders.intervene',
        target: 'order',
        transport: 'delegated',
        summary: 'Cancelled an order',
    },
    /**
     * Its own name beside `orders.cancel` although they share one permission — the
     * `vendors.suspend` / `vendors.reinstate` reasoning. They are opposite interventions
     * and a single action name makes the feed unreadable: "why did this order move" is
     * answered by which verb was used, not by reading the payload.
     */
    'orders.dispatch': {
        permission: 'orders.intervene',
        target: 'order',
        transport: 'delegated',
        summary: 'Dispatched a stalled order to its delivery agency',
    },
    /**
     * The `after` on this row is the ONLY place the platform records which of the vendor's
     * commercial gates an administrator overrode. jovi-mall stores the amount and the
     * reason on the RefundTransaction; what it cannot store is "this was 9 days outside
     * their 14-day return window", because that is a fact about a policy evaluated once,
     * at the moment of the override, against terms the vendor may edit tomorrow.
     */
    'orders.refund': {
        permission: 'orders.refund',
        target: 'order',
        transport: 'delegated',
        summary: 'Refunded an order, in full or in part',
    },

    // ═══ SHIPMENTS — delegated to jovi-mall (Phase 10) ════════════════════════
    // Two mutations. There is deliberately no `shipments.status.set`: the declared
    // permissions are read, reassign and cancel, and driving the delivery lifecycle is the
    // agent's and the agency's. An admin status-transition would also need a third member
    // on jovi-mall's `ShipmentStatusActor` carrying neither an agencyId nor an agentId —
    // which would strip both ownership predicates out of the compare-and-set filter that
    // makes two actors on one shipment safe.

    'shipments.reassign': {
        permission: 'shipments.reassign',
        target: 'shipment',
        transport: 'delegated',
        summary: 'Moved a shipment to a different delivery agent',
    },
    /**
     * `before`/`after` on this row is the only record of which agent was taken off a
     * delivery: the shipment document afterwards no longer holds the old agent's id.
     */
    'shipments.cancel': {
        permission: 'shipments.cancel',
        target: 'shipment',
        transport: 'delegated',
        summary: 'Cancelled a shipment and put its items back for re-routing',
    },

    // ═══ BILLING — delegated to jovi-mall (Phase 11) ══════════════════════════
    // The catalog writes and the three assignments. Reads are not here: a plan list and
    // a plan detail are not actions.
    //
    // ── Why `assign` is THREE actions and not one ────────────────────────────
    // `AuditActionSpec.target` is a single target type, and `buildQueryFilter` matches on
    // `target_type`/`target_id` only — it does not consult `related_target_*`. One action
    // targeting `plan` with the owner carried as a related target would therefore be
    // invisible on `/vendors/:id/activity`, which is the one feed an operator actually
    // opens when asking what happened to a vendor's billing. Splitting by owner type puts
    // each row on its subject's own feed. Same reasoning as `agents.unban` being its own
    // action rather than `agents.ban` with a flag.

    'billing.plans.create': {
        permission: 'billing.plans.manage', target: 'plan', transport: 'delegated',
        summary: 'Created a pricing plan',
    },
    /**
     * Editing a plan is not editing a record — `commission_percent` is what every future
     * order's split multiplies by, and `max_active_products` can put a vendor over their
     * cap retroactively. `before`/`after` on this row is the only history those numbers have.
     */
    'billing.plans.update': {
        permission: 'billing.plans.manage', target: 'plan', transport: 'delegated',
        summary: 'Edited a pricing plan',
    },
    'billing.plans.delete': {
        permission: 'billing.plans.delete', target: 'plan', transport: 'delegated',
        summary: 'Archived a pricing plan',
    },
    'billing.subscriptions.assign_vendor': {
        permission: 'billing.subscriptions.assign', target: 'vendor', transport: 'delegated',
        summary: 'Assigned a subscription plan to a vendor',
    },
    'billing.subscriptions.assign_agency': {
        permission: 'billing.subscriptions.assign', target: 'agency', transport: 'delegated',
        summary: 'Assigned a subscription plan to an agency',
    },
    'billing.subscriptions.assign_agent': {
        permission: 'billing.subscriptions.assign', target: 'agent', transport: 'delegated',
        summary: 'Assigned a subscription plan to a delivery agent',
    },

    // ═══ MONEY — payouts (Phase 11) ═══════════════════════════════════════════

    'money.payouts.mark_paid': {
        permission: 'money.payouts.mark_paid', target: 'payout', transport: 'delegated',
        summary: 'Marked a payout request paid — money has left the platform',
    },
    'cod.triage': {
        permission: 'cod.triage', target: 'agency', transport: 'delegated',
        summary: 'Endorsed a declared COD deposit or remittance as genuine — a review note, not a confirmation',
    },
    'money.payouts.triage': {
        permission: 'money.payouts.triage', target: 'payout', transport: 'delegated',
        summary: 'Endorsed a payout request as genuine — a review note, not a payment',
    },
    'money.payouts.reject': {
        permission: 'money.payouts.reject', target: 'payout', transport: 'delegated',
        summary: 'Rejected a payout request and returned the funds to the available balance',
    },
    /**
     * The one audited READ in this catalog, and the exception is argued rather than assumed.
     *
     * "Reads are not actions" holds because a read leaves no state behind, so the
     * permission check is the entire control. This read breaks that in one specific way:
     * its output is a beneficiary's account number — the material a fraudulent payout
     * instruction is built from. For a disclosure the interesting question is not who MAY
     * but who DID, and how often: forty reveals in an hour is somebody copying the payout
     * roster, and nothing else in this service would ever see that.
     *
     * `external` rather than `observation`. `observation` is best-effort and swallows a
     * write failure, which is right for a login that already happened on its own terms and
     * wrong here, where the audit row IS the control. `auditedAttempt` commits the intent
     * first and does not catch — so with the audit store down, the disclosure never runs.
     *
     * The row records WHICH KINDS were revealed, never the values — putting them here would
     * move a beneficiary's account number into the one store readable without the permission
     * that gates it. See `money/domain/payout-disclosure.ts`.
     */
    'money.payouts.destination.read': {
        permission: 'money.payouts.destination.read', target: 'payout', transport: 'external',
        summary: 'Revealed the full payout destination on a payout request',
    },

    // ═══ AUDIT — the trail's own operations ═══════════════════════════════════
    // Exporting moves data out of the system and is the only path that deletes a row,
    // so both are audited. Reads are not (volume; the request log already has them).

    // ═══ DEVELOPER TOOLS ═══ Phase 12 ═════════════════════════════════════════
    //
    // Every one of these re-runs a side effect against LIVE data, which is why all four
    // permissions are flagged `destructive` and confined to tier 1. They are the actions
    // the brief calls "developer tool execution", and until Phase 12 the permissions
    // existed with no routes and no audit actions — so the capability was catalogued as
    // policy and unrecordable in practice.
    //
    // `developer_tools.webhooks.redeliver` is deliberately ABSENT. Every `/webhooks/*` mount
    // in jovi-mall is inbound (payments, WhatsApp, Telegram); there is no outbound delivery
    // record to redeliver, and the only outbound mechanism is `tracking_outbox`, which
    // `outbox.replay` already covers. An action whose subject does not exist would be worse
    // than the unused permission, which at least names its missing prerequisite.

    'developer_tools.feature_flags.set': {
        permission: 'developer_tools.feature_flags.set',
        target: 'feature_flag',
        transport: 'wi_admin_txn',
        summary: 'Turned a feature flag on or off',
    },
    'developer_tools.workers.trigger': {
        permission: 'developer_tools.workers.trigger',
        target: 'worker',
        transport: 'delegated',
        summary: 'Ran a background worker immediately, against live data',
    },
    /**
     * `target: 'none'` — a replay acts on a SET of outbox rows chosen by a filter, not on
     * one record with an id. The count and the filter go in the payload, where they can be
     * read; a target naming one of the rows would be arbitrary.
     */
    'developer_tools.outbox.replay': {
        permission: 'developer_tools.outbox.replay',
        target: 'none',
        transport: 'delegated',
        summary: 'Replayed failed outbound events — downstream services see them again',
    },
    'developer_tools.catalogue.vectorise': {
        permission: 'developer_tools.catalogue.vectorise',
        target: 'none',
        transport: 'delegated',
        summary: 'Rebuilt search vectors across the product catalogue',
    },

    // ═══ Phase 14 — system operations ═════════════════════════════════════════
    /**
     * The one operator action that takes the platform off the air, so it gets a real target
     * type rather than `none`. `attempted` → outcome matters more here than anywhere else on
     * this router: a crash mid-flight leaves a row naming the window that was about to open,
     * which is exactly what somebody investigating an unexplained outage needs to find.
     */
    'developer_tools.maintenance.set': {
        permission: 'developer_tools.maintenance.set',
        target: 'maintenance_window',
        transport: 'delegated',
        summary: 'Changed the platform maintenance mode',
    },
    /**
     * `target: 'none'`, for the same documented reason as `outbox.replay` above: a flush acts on
     * a SET of keys chosen by a filter, not on one record with an id. The database, the prefix,
     * the counts **and the blast-radius note jovi-mall returns** all go in the payload and the
     * outcome, where they can be read.
     */
    'developer_tools.cache.flush': {
        permission: 'developer_tools.cache.flush',
        target: 'none',
        transport: 'delegated',
        summary: 'Deleted cached keys from a platform Redis database',
    },

    // ═══ Phase 15 ═════════════════════════════════════════════════════════════
    /**
     * One new action, because Phase 15 adds exactly one new dangerous verb — a diagnostics phase
     * that grew a lot of them would have misunderstood itself. Everything else it adds observes.
     *
     * `target: 'none'` for the third time and for the same reason as `outbox.replay` and
     * `cache.flush` directly above: it acts on a SET chosen by a filter, not on one record with
     * an id. An `outbox_row` target type would imply an id this action does not have. The age,
     * the cutoff, the dry-run flag and the matched/deleted counts all go in the payload and the
     * outcome, where they are readable.
     */
    'developer_tools.outbox.prune': {
        permission: 'developer_tools.outbox.prune',
        target: 'none',
        transport: 'delegated',
        summary: 'Deleted delivered tracking-outbox rows past a retention age',
    },

    /**
     * ── These three are `external`, and `wi_admin_txn` was wrong for all of them ──
     *
     * They act on a FILE and on bulk row ranges. Neither fits in one wi-admin transaction:
     *
     *   - `runExport` streams a cursor to an NDJSON file, fsyncs and renames it. That is
     *     minutes of wall time plus a filesystem side effect, and `withTransaction` re-runs
     *     its callback — a retry would re-export.
     *   - `purgeExpired` deletes a range. Wrapped whole it would breach the 16 MB
     *     transaction entry limit and `transactionLifetimeLimitSeconds` on any real trail;
     *     it now deletes in bounded batches, which a single transaction cannot span.
     *
     * `external` + `auditedAttempt` gives the better property anyway for a DELETION: the
     * intent is committed BEFORE the rows go, so a crash mid-purge leaves a dangling
     * `attempted` row naming what was about to be removed rather than silence.
     *
     * They were declared `wi_admin_txn` from Phase 3.5 and — separately — never written at
     * all, so nothing ever exercised the contradiction. See ADR-006's Phase 12 addendum.
     */
    'audit.export': {
        permission: 'audit.export', target: 'audit_export', transport: 'external',
        summary: 'Exported the audit record',
    },
    'audit.purge': {
        permission: null, target: 'audit_export', transport: 'external',
        summary: 'Deleted exported audit rows past their retention period',
    },
    /**
     * Changing `ADMIN_AUDIT_RETENTION_DAYS` rewrites `purge_after` on every exported row —
     * it moves the date on which the record becomes deletable, for the whole archive at
     * once. That is a retention-policy change and among the most consequential things this
     * service can do to its own evidence, and until Phase 12 it was neither catalogued nor
     * recorded.
     */
    'audit.retention.restamp': {
        permission: 'audit.export', target: 'audit_export', transport: 'external',
        summary: 'Recomputed when exported audit rows become deletable',
    },

    // ═══ NOTIFICATIONS ═══ Phase 13 ═══════════════════════════════════════════
    /**
     * The ONLY audited write on the inbox surface, and the line is worth stating.
     *
     * Marking a notification read or archived is a record of having LOOKED, and ADR-006 D-5
     * already decided reads are not audited — those five routes are in
     * `NO_AUDIT_ROUTE_ALLOWLIST` with that reasoning. A preference is different in kind:
     * it is durable configuration that changes which notifications this service raises for
     * this administrator from now on, so "who turned off COD discrepancy alerts, and when"
     * is a question the trail has to be able to answer.
     *
     * `permission: null`, mirroring `administrators.profile.update_self` directly above:
     * the route is `selfService`, so `checkPermissionCoherence` has no route permission to
     * reconcile against and returns early. Target is the administrator, because the
     * preference is a fact about them.
     */
    'notifications.preferences.update_self': {
        permission: null,
        target: 'administrator',
        transport: 'wi_admin_txn',
        summary: 'Changed their own notification preferences',
    },
} as const satisfies Record<string, AuditActionSpec>);

export type AuditAction = keyof typeof AUDIT_CATALOG;

export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_CATALOG) as [AuditAction, ...AuditAction[]];

export function auditSpec(action: AuditAction): AuditActionSpec {
    return AUDIT_CATALOG[action];
}

/** Narrow an unvalidated string. `Object.prototype` keys are refused by the explicit lookup. */
export function isAuditAction(value: unknown): value is AuditAction {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AUDIT_CATALOG, value);
}

/**
 * Refuse to start on an inconsistent registry.
 *
 * Runs in `createApp()` beside `assertGrantTableValid()`, for the same reason that one
 * does: a service with an incoherent policy table is worse than one that is down,
 * because it looks like it is working. A typo'd permission name here would silently
 * produce rows whose `sensitive` flag is wrong, and `sensitive` is what read-scoping and
 * alerting key off.
 */
export function assertAuditCatalogValid(): void {
    const problems: string[] = [];
    const families = new Set<string>(PERMISSION_FAMILIES);
    const targets = new Set<string>(AUDIT_TARGET_TYPES);

    for (const [action, spec] of Object.entries(AUDIT_CATALOG) as [string, AuditActionSpec][]) {
        const [family, ...rest] = action.split('.');

        if (rest.length === 0) {
            problems.push(`${action} is not a dotted name — expected family.resource.action`);
        }
        if (!families.has(family)) {
            problems.push(`${action} has family "${family}", which is not a permission family`);
        }
        if (!targets.has(spec.target)) {
            problems.push(`${action} names target "${spec.target}", which is not an audit target type`);
        }
        if (spec.permission !== null && !(spec.permission in PERMISSION_CATALOG)) {
            problems.push(`${action} names permission "${spec.permission}", which is not in the catalog`);
        }
        if (spec.permission !== null && !spec.permission.startsWith(`${family}.`)) {
            // Not pedantry: `sensitive` is copied from this permission's flags, so an
            // action pointing at another family's permission would inherit the wrong
            // sensitivity and be readable by the wrong tier.
            problems.push(
                `${action} is governed by "${spec.permission}", which belongs to a different family`,
            );
        }
        if (spec.summary.trim().length === 0) {
            problems.push(`${action} has an empty summary`);
        }
    }

    if (problems.length > 0) {
        throw createAppError(
            ERROR_CODES.AUDIT_CATALOG_INVALID,
            500,
            `The audit action registry is inconsistent:\n  - ${problems.join('\n  - ')}`,
            { problemCount: problems.length, problems },
        );
    }
}

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
    'agents.transfer': {
        permission: 'agents.transfer',
        target: 'agent',
        transport: 'delegated',
        summary: 'Moved an agent from one delivery agency to another',
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

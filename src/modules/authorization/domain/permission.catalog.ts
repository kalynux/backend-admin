import { DualControlSpec, PermissionSpec } from './permission.types';

/**
 * THE permission catalog. Every operation this service will ever authorize is named here.
 *
 * ── How to read this file ─────────────────────────────────────────────────────
 * Names are `family.resource.action`, or `family.action` where the family has one
 * resource. The name describes the OPERATION, never the person: `cod.remittances.confirm`
 * stays true when the org chart changes, `minTier: 2` does not.
 *
 * Entries exist for endpoints that do not exist yet. That is deliberate and is most of
 * the value of writing this now: Phase 5 ports 81 endpoints and Phase 6 builds nine
 * domains, and both consume a policy that was decided once, here, rather than argued
 * per-endpoint by whoever ports it. `phase` records which one builds the surface.
 *
 * ── How to add one ────────────────────────────────────────────────────────────
 * 1. Add the entry below, with a `summary` an administrator could read.
 * 2. Flag it `financial` / `escalation` / `destructive` if it is any of those. Getting
 *    this wrong is the one mistake with real consequences: an unflagged financial write
 *    can be swept into a tier by `allInFamily()`.
 * 3. Add it to tier 1 in tier-grants.ts, and to tiers 2 and 3 if they should hold it.
 *    The boot assertion refuses to start until tier 1 lists it, so this is not optional.
 *
 * `as const satisfies` gives both halves of what this needs: `satisfies` type-checks
 * every entry against PermissionSpec, and `as const` keeps the literal keys so
 * `PermissionName` is a union and `requirePermission('typo.here')` is a COMPILE error.
 */

// ─── Dual-control specs ──────────────────────────────────────────────────────
//
// Declared as named constants rather than inline, because an approval rule is a policy
// statement worth reading on its own.

/**
 * Promoting anyone to Developer — the top of the tree — takes two Developers.
 *
 * This is the rule that makes a rogue Developer recoverable. Combined with the
 * no-self-action rule in escalation.rules.ts, no single account can create a peer, and
 * an existing Developer can be suspended by another one without either being able to act
 * alone. A demotion (to tier 2 or 3) is NOT dual-controlled: reducing privilege is the
 * safe direction, and needing a quorum to contain a compromised account would be exactly
 * backwards.
 */
const PROMOTE_TO_DEVELOPER: DualControlSpec = {
    when: (payload) => payload.tier === 1,
    approverPermission: 'administrators.tier.set',
    describe: (payload) => `Promote administrator ${String(payload.adminId)} to Developer (tier 1)`,
};

/**
 * Suspending or reinstating a Developer takes a second Developer.
 *
 * The other half of the same rule. Suspension is how a compromised Developer is
 * contained, so it must be reachable — but a single Developer able to suspend the others
 * unilaterally is the compromise, not the fix. Reinstatement rides the same spec because
 * restoring a suspended Developer grants Developer access to an account that currently has
 * none, which is exactly as consequential as promoting one.
 *
 * Keyed on the TARGET's level, which the payload carries: suspending an Admin or a
 * Support administrator is ordinary work and is not queued.
 */
const ACT_ON_PEER_DEVELOPER: DualControlSpec = {
    when: (payload) => payload.targetTier === 1,
    approverPermission: 'administrators.suspend',
    describe: (payload) =>
        `${payload.suspend === true ? 'Suspend' : 'Reinstate'} Developer ${String(payload.adminId)}`,
};

/**
 * A payout at or above the platform's own auto-payout threshold takes two administrators.
 *
 * PHASE-0:436 promised "financial actions above a threshold require a second admin's
 * approval" and the requirement then vanished from every later document. This is it —
 * Phase 11's, and the first non-escalation use of the machinery Phase 3 built generically
 * for exactly this.
 *
 * ── Why THIS number ───────────────────────────────────────────────────────────
 * `2_000_000` is `EARNINGS_CONFIG.AUTO_PAYOUT_THRESHOLD`: the balance at which the platform
 * opens a payout request on an owner's behalf, because it has decided it does not want to
 * owe one party more than that. Reusing it means the four-eyes line is the platform's own
 * definition of "a lot of money" rather than a second, arbitrary one that would drift from
 * it. `test-money.ts` reads jovi-mall's source and asserts the two still agree.
 *
 * Inlined rather than imported, matching `PROMOTE_TO_DEVELOPER`'s inline `payload.tier === 1`:
 * jovi-mall exports no config to this service, and a constant declared here that merely
 * *claims* to mirror one is what the drift test is for.
 *
 * ── Why mark-paid and not reject ──────────────────────────────────────────────
 * Marking paid asserts money has left the platform, which nothing on either side can undo.
 * Rejecting returns it to the owner's available balance, and the owner can simply request
 * again. A quorum belongs on the irreversible direction — the same reasoning that leaves a
 * DEMOTION out of `PROMOTE_TO_DEVELOPER`.
 *
 * ── The subtlety `when` carries ───────────────────────────────────────────────
 * The amount is NOT in the request body — `POST /money/payouts/:payoutId/mark-paid` carries
 * only an optional reference — so the controller reads the payout and builds the payload
 * from the row. A client that could name the amount could name 1,999,999 and skip the
 * second administrator. `MarkPaidSchema` is `.strict()` so that an `amount` key is a 400
 * rather than a silently ignored field.
 *
 * `typeof payload.amount === 'number'` is load-bearing: `'2000000' >= 2_000_000` is TRUE in
 * JavaScript, so a string amount reaching here would trip the rule for the right reason by
 * accident and a string `'1999999'` would not — but an unparsed body is a bug either way,
 * and the guard makes it fail closed as "not a number, not a large payout, refuse to guess".
 */
const LARGE_PAYOUT: DualControlSpec = {
    when: (payload) => typeof payload.amount === 'number' && payload.amount >= 2_000_000,
    approverPermission: 'money.payouts.mark_paid',
    describe: (payload) =>
        `Mark payout request ${String(payload.payoutId)} PAID — `
        + `${String(payload.currency)} ${Number(payload.amount).toLocaleString()} `
        + `to ${String(payload.ownerType)} ${String(payload.ownerId)}`,
};

/**
 * Frozen at runtime, not only at compile time.
 *
 * `as const satisfies` is erased by the compiler, so without `Object.freeze` a permission
 * could be injected into the object at runtime — and `isPermissionName()` reads the
 * catalog with `hasOwnProperty`, so it would accept the injected name. Freezing makes the
 * catalog what the type system already claims it is.
 */
export const PERMISSION_CATALOG = Object.freeze({
    // ═══ AGENTS ═══ 11 legacy endpoints under /api/admin/agents ═══════════════
    'agents.read': {
        family: 'agents', action: 'read', phase: 5,
        summary: 'View delivery agents, their history, COD allocation, tracking policy and eligibility',
    },
    'agents.status.set': {
        family: 'agents', action: 'write', phase: 5,
        summary: 'Activate or suspend an agent (a reason is required to suspend)',
    },
    'agents.ban': {
        family: 'agents', action: 'write', phase: 5, destructive: true,
        summary: 'Permanently ban an agent from the platform',
    },
    'agents.kyc.review': {
        family: 'agents', action: 'write', phase: 5,
        summary: 'Approve or reject an agent’s identity documents — this is what lets an agent work',
    },
    'agents.tracking.set': {
        family: 'agents', action: 'write', phase: 5,
        summary: 'Override an agent’s live-location tracking permission',
    },
    /**
     * Reading geo-tracker's live tracking data — the door ADR-020 opened, and the first
     * permission in this catalog that reaches a second service's *data*.
     *
     * ── Why it is not `agents.read` ───────────────────────────────────────────
     * `agents.read` already carries `tracking.lastKnown.position`, which the dashboard's
     * DATA-EXPOSURE-REGISTER §1 flagged and which was answered "it stays" on the grounds
     * that a last-known position is a historical record. This is categorically sharper:
     * a LIVE position, and a delivery's minute-by-minute GPS trail. Ask #1 of that
     * register was "gate the field on a permission of its own"; that ask was declined for
     * the stale mirror and is granted here, where it is the right answer.
     *
     * ── Support HOLDS it, and that was a decision, not an oversight ───────────
     * "Where is my delivery right now" is one of the commonest tickets, and refusing it to
     * the tier that answers tickets escalates every one of them. The exposure that buys is
     * real and is balanced deliberately by the OTHER half of the same decision: every read
     * under this permission that emits coordinates writes an audit row FIRST, fail-closed,
     * so the control is "who did, and how often" rather than "who may". See
     * `agents/domain/tracking-disclosure.ts`.
     *
     * ── Unflagged, and each flag is refused for a reason ──────────────────────
     * Not `financial` (no money), not `destructive` (nothing is written at all — every
     * route is a GET), not `escalation` (it grants no privilege). Flagging it would drop
     * it out of `allInFamily('agents')` for tier 2 AND make `assertGrantTableValid()`
     * refuse it to Support at boot, which is the opposite of what was decided.
     *
     * It covers the AGENT-scoped half of that door only — presence and the live position.
     * The delivery's GPS trail is `shipments.tracking.read`, in its own family: the two are
     * different exposures (live surveillance of a person, versus a case file about a
     * delivery) and an operator should be able to grant them apart, which is also how
     * geo-tracker's own scope model separates them.
     */
    'agents.tracking.read': {
        family: 'agents', action: 'read', phase: 6,
        summary: 'Read an agent’s live tracking state and live position from geo-tracker — every position read is recorded in the audit trail',
    },
    'agents.cod_threshold.set': {
        family: 'agents', action: 'write', phase: 5, financial: true,
        summary: 'Set how much cash on delivery an agent may hold before remitting',
    },
    'agents.transfer': {
        family: 'agents', action: 'write', phase: 5,
        summary: 'Move an agent from one delivery agency to another',
    },
    /**
     * Freezing or ending ONE agent↔agency contract — added in the dashboard-request round.
     *
     * ── The line it sits on, because the family's docs argue the opposite case ───
     * `agents.md` refuses contract writes on the grounds that "a live contract's terms
     * change by proposal between the two parties, never by edit". That reasoning is
     * sound and this permission does not touch it: approving a pending contract and
     * rewriting agreed terms stay refused, and stay refused for that exact reason — a
     * `terms_proposed_by: null` contract exists precisely because nobody has stated
     * terms, so approving it binds an agent to a default that pays zero.
     *
     * What this grants is suspend, reinstate and terminate. "Do not let an administrator
     * impose terms" and "do not let an administrator stop an abusive relationship" are
     * different claims, and only the first was ever argued. It is the same lever
     * `agencies.deactivate` already provides one level up.
     *
     * ⚠️ Not `destructive`, deliberately, and the reason is mechanical as well as
     * semantic: nothing is deleted (every status change is append-only history), and
     * flagging it would drop it out of `allInFamily()` for tier 2, whose job this is.
     * Terminate is the closest to destructive and is also the one jovi-mall may refuse
     * outright — it needs the counterparty's agreement and the outstanding COD and agent
     * payment cleared, and there is no administrative override.
     *
     * Support does not hold it: freezing somebody's livelihood is not ticket work.
     */
    'agents.contracts.manage': {
        family: 'agents', action: 'write', phase: 5,
        summary: 'Suspend, reinstate or terminate one agent↔agency contract (never its terms)',
    },

    // ═══ AGENCIES ═══ 4 legacy endpoints ══════════════════════════════════════
    'agencies.read': {
        family: 'agencies', action: 'read', phase: 5,
        summary: 'View delivery agencies and their details',
    },
    /**
     * Added at Phase 9, and it is the verb this family was missing rather than a new idea.
     *
     * PHASE-0 recorded that agencies have deactivate/reactivate and no approval at all.
     * Measured since: `legit_verified` gates nothing (`requireLegitBusiness` has zero call
     * sites), and `delivery_agencies.status` has exactly two writers — the two below. So
     * `pending_verification`, the status every agency is created at, has no exit except
     * `reactivate`, an endpoint whose name says the opposite and which also runs the whole
     * product-restore cascade.
     *
     * This is the exit. Unflagged, so `allInFamily('agencies')` grants it to tier 2 and
     * Support does not hold it — matching `agents.kyc.review`, its exact analogue.
     */
    'agencies.verify': {
        family: 'agencies', action: 'write', phase: 9,
        summary: 'Approve a delivery agency’s business verification — this is what lets a pending agency operate',
    },
    'agencies.deactivate': {
        family: 'agencies', action: 'write', phase: 5, destructive: true,
        summary: 'Deactivate a delivery agency — cascades a suspension across every vendor product that defaults to it',
    },
    'agencies.reactivate': {
        family: 'agencies', action: 'write', phase: 5,
        summary: 'Reactivate a previously deactivated delivery agency',
    },

    // ═══ BILLING ═══ 7 legacy endpoints ═══════════════════════════════════════
    'billing.plans.read': {
        family: 'billing', action: 'read', phase: 5,
        summary: 'View subscription plans',
    },
    'billing.plans.manage': {
        family: 'billing', action: 'write', phase: 5,
        summary: 'Create and edit subscription plans',
    },
    'billing.plans.delete': {
        family: 'billing', action: 'write', phase: 5, destructive: true,
        summary: 'Delete a subscription plan',
    },
    'billing.subscriptions.assign': {
        family: 'billing', action: 'write', phase: 5, financial: true,
        summary: 'Assign a plan to a vendor, agency or agent — changes what they are billed',
    },

    // ═══ COD ═══ 13 legacy endpoints under /api/admin/cod ═════════════════════
    // Every write here is financial. PHASE-0:274 flagged that the read overview and the
    // deposit-creating write sit behind one identical guard today; they do not here.
    'cod.overview.read': {
        family: 'cod', action: 'read', phase: 5,
        summary: 'View the cash-on-delivery position across the platform',
    },
    'cod.remittances.read': {
        family: 'cod', action: 'read', phase: 5,
        summary: 'View cash remittances declared by agencies',
    },
    'cod.remittances.confirm': {
        family: 'cod', action: 'write', phase: 5, financial: true,
        summary: 'Confirm a cash remittance — settles collections FIFO and unlocks the agency’s earnings',
    },
    'cod.remittances.reject': {
        family: 'cod', action: 'write', phase: 5, financial: true,
        summary: 'Reject a declared cash remittance',
    },
    'cod.deposits.read': {
        family: 'cod', action: 'read', phase: 5,
        summary: 'View cash deposits paid directly to the platform',
    },
    'cod.deposits.create': {
        family: 'cod', action: 'write', phase: 5, financial: true,
        summary: 'Record cash received directly from an agent or agency',
    },
    'cod.deposits.confirm': {
        family: 'cod', action: 'write', phase: 5, financial: true,
        summary: 'Confirm a recorded cash deposit',
    },
    'cod.deposits.reject': {
        family: 'cod', action: 'write', phase: 5, financial: true,
        summary: 'Reject a recorded cash deposit',
    },
    'cod.discrepancies.read': {
        family: 'cod', action: 'read', phase: 5,
        summary: 'View cash discrepancies raised against agents and agencies',
    },
    'cod.discrepancies.resolve': {
        family: 'cod', action: 'write', phase: 5, financial: true,
        summary: 'Resolve a cash discrepancy, deciding who absorbs the shortfall',
    },
    'cod.holders.read': {
        family: 'cod', action: 'read', phase: 5,
        summary: 'View which agents and agencies are currently holding platform cash',
    },
    'cod.trust.adjust': {
        family: 'cod', action: 'write', phase: 5, financial: true,
        summary: 'Manually adjust an agent’s cash trust score, changing how much they may carry',
    },

    /**
     * The COD pre-screen — and unlike its payout sibling, this one is NOT `financial`.
     *
     * The asymmetry is real rather than an oversight, and it comes from what the two records
     * are holding. A payout request holds the owner's balance in `requested_balance` from the
     * moment it opens, so its triage reject releases a hold — a money movement, hence the
     * flag and hence the named tier-3 exemption. A COD deposit or remittance in `declared`
     * holds NOTHING: only a CONFIRMED one moves cash. Endorsing one moves nothing, and
     * rejecting one moves nothing either.
     *
     * So this needs no exemption and takes none. Being unflagged also means
     * `allInFamily('cod')` expands it, which is correct: an Admin should hold it without
     * anybody having to type it into the tier-2 block by hand.
     *
     * ⚠ It does NOT grant confirming. `cod.deposits.confirm` and `cod.remittances.confirm`
     * are the writes that assert cash arrived, they stay `financial`, and they stay out of
     * Support's reach.
     */
    'cod.triage': {
        family: 'cod', action: 'write', phase: 5,
        summary: 'Endorse a declared COD deposit or remittance as genuine — never confirms cash',
    },

    // ═══ MONEY ═══ platform earnings (2) + payout requests (4) ════════════════
    'money.earnings.read': {
        family: 'money', action: 'read', phase: 5,
        summary: 'View platform earnings and the earnings ledger',
    },
    'money.payouts.read': {
        family: 'money', action: 'read', phase: 5,
        summary: 'View the payout request queue',
    },
    /**
     * `dualControl` was attached WITH the `/money` module rather than when the permission
     * was written, and the ordering was forced rather than stylistic:
     * `assertDualControlHandlersRegistered()` refuses to boot a spec whose handler is not
     * registered, and the handler cannot exist before the gateway it delegates through.
     * Attaching it early would have left the service unbootable for as long as it took to
     * build the module. The handler lives in `money/domain/payout-dual-control.ts` and
     * `money.routes.ts` imports it for side effect.
     *
     * The permission was already `financial`, so adding `dualControl` changed nothing about
     * who holds it: both flags make `isSensitive` true, `allInFamily('money')` already
     * refused it, and it was already named into the tier-2 block by hand.
     */
    'money.payouts.mark_paid': {
        family: 'money', action: 'write', phase: 5, financial: true,
        dualControl: LARGE_PAYOUT,
        summary: 'Mark a payout request as paid — records that money has left the platform',
    },
    'money.payouts.reject': {
        family: 'money', action: 'write', phase: 5, financial: true,
        summary: 'Reject a payout request',
    },
    /**
     * The pre-screen, and the ONLY financial permission any tier-3 administrator holds.
     *
     * ── Why it is flagged `financial` when it moves nothing out ────────────────
     * Because one of its two verdicts moves money between columns. A payout request holds
     * the owner's whole balance in `requested_balance` from the moment it opens; endorsing
     * touches nothing, but REJECTING releases that hold back to `available_balance`. That is
     * a financial write by this catalog's own definition, and flagging it otherwise to make
     * the grant table accept it would be exactly the misdescription D-8 warns against —
     * the flags are load-bearing, not documentation.
     *
     * So it is flagged honestly and the grant table takes a NAMED exemption instead. See
     * `TIER_3_FINANCIAL_ALLOWLIST` in tier-grants.ts, which is a two-file change on purpose.
     *
     * ── What it deliberately does NOT grant ────────────────────────────────────
     * Sending. `money.payouts.mark_paid` is a separate permission this tier does not hold,
     * and no combination of triage verdicts causes money to leave the platform. The reject
     * direction is also the reversible one — the owner simply requests again — which is the
     * same asymmetry that leaves `money.payouts.reject` out of dual control.
     */
    'money.payouts.triage': {
        family: 'money', action: 'write', phase: 5, financial: true,
        summary: 'Endorse a payout request as genuine, or reject it — never sends money',
    },
    /**
     * The gateway on the one field this service will not show by default.
     *
     * Every other payout read renders the destination by its provider and account name —
     * enough to recognise it, and not the digits at all, because `PAYOUT_LIST_PROJECTION`
     * never reads them. This reveals them, one payout at a time, and the read is written to
     * the audit trail before the value is fetched.
     *
     * `financial` is doing real work here rather than describing a money movement: it
     * keeps the name out of `allInFamily('money')` and refuses it to Support at boot.
     * See the flag's own docstring for why a read carries it.
     */
    'money.payouts.destination.read': {
        family: 'money', action: 'read', phase: 11, financial: true,
        summary: 'Reveal the full payout destination (account or mobile number) on one payout request — every reveal is recorded in the audit trail',
    },
    /**
     * Gateway settlements — what a customer actually paid, and what was refunded.
     *
     * Deliberately NOT flagged. A settlement row carries an amount, a status and a
     * gateway reference; it is the record Support needs to answer "did my payment go
     * through", and the fields that would make it sharp — the raw gateway payload, the
     * idempotency key, the payload hash — are excluded by projection, not by permission.
     */
    'money.payments.read': {
        family: 'money', action: 'read', phase: 11,
        summary: 'View gateway payment and refund settlements',
    },

    // ═══ ORDERS ═══ 2 legacy endpoints + the list/search/refund surface (Ph. 6) ═
    'orders.read': {
        family: 'orders', action: 'read', phase: 6,
        summary: 'Search orders and view an order’s detail and timeline',
    },
    'orders.disputes.read': {
        family: 'orders', action: 'read', phase: 5,
        summary: 'View the order dispute queue',
    },
    'orders.disputes.resolve': {
        family: 'orders', action: 'write', phase: 5, financial: true,
        summary: 'Resolve an order dispute, deciding who is paid',
    },
    'orders.intervene': {
        family: 'orders', action: 'write', phase: 6,
        summary: 'Manually change an order’s state to unblock it',
    },
    'orders.refund': {
        family: 'orders', action: 'write', phase: 6, financial: true,
        summary: 'Refund an order, in full or in part',
    },

    // ═══ SUPPORT ═══ 18 legacy ticket endpoints ═══════════════════════════════
    // The Support tier's home. Every read is scoped: a Support administrator sees the
    // tickets assigned to them and the unassigned queue, not everyone's. See
    // resource-scope.ts — the scope is enforced in the query, not in a controller.
    /**
     * Phase 16 — the Support rung of the error-exposure ladder.
     *
     * In the `support` family, so `allInFamily('support')` sweeps it into tier 3 and the
     * strict-nesting assertion carries it up to 2 and 1. What it grants is deliberately NOT
     * a smaller version of `system.errors.read`: it is what the CALLER already saw, plus a
     * reference and a category — see `system/domain/error-exposure.ts`.
     */
    'support.errors.lookup': {
        family: 'support', action: 'read', phase: 16,
        summary: "Look up an error a vendor, agency, agent or customer hit, by its reference",
    },

    /**
     * ADR-022 — the Support rung of the automation-failure ladder.
     *
     * In the `support` family so `allInFamily('support')` sweeps it into tier 3, and the
     * strict-nesting assertion carries it to 2 and 1. Same mechanism as
     * `support.errors.lookup` directly above, and for the same reason: tier 3's grants are
     * an explicit list, so a `system.*` name would not reach it.
     *
     * What it grants is the thinnest view in the projection — a channel, a kind and a
     * timestamp. "The bot did not reply to me" is a ticket, and an agent who cannot see
     * that the automation layer was degraded escalates it to somebody who knows less about
     * it than they do. What they deliberately do NOT get is the machine detail, which on a
     * support call is not a secret so much as a false lead.
     */
    'support.automation.lookup': {
        family: 'support', action: 'read', phase: 22,
        summary: 'See whether the customer bot was degraded on a channel, and when',
    },

    'support.tickets.read': {
        family: 'support', action: 'read', phase: 5, scope: 'tickets',
        summary: 'View support tickets',
    },
    'support.tickets.create': {
        family: 'support', action: 'write', phase: 5,
        summary: 'Open a support ticket on someone’s behalf',
    },
    'support.tickets.update': {
        family: 'support', action: 'write', phase: 5, scope: 'tickets',
        summary: 'Edit a ticket’s subject, body, status or priority',
    },
    'support.tickets.assign': {
        family: 'support', action: 'write', phase: 5,
        summary: 'Assign a ticket to an administrator, or take it from the unassigned queue',
    },
    'support.tickets.lifecycle': {
        family: 'support', action: 'write', phase: 5, scope: 'tickets',
        summary: 'Close and reopen tickets',
    },
    'support.tickets.followers.manage': {
        family: 'support', action: 'write', phase: 5, scope: 'tickets',
        summary: 'Add and remove ticket followers',
    },
    'support.tickets.notes.read': {
        family: 'support', action: 'read', phase: 5, scope: 'tickets',
        summary: 'Read internal notes on a ticket — never visible to the customer',
    },
    'support.tickets.notes.write': {
        family: 'support', action: 'write', phase: 5, scope: 'tickets',
        summary: 'Add an internal note to a ticket',
    },
    'support.tickets.attachments.read': {
        family: 'support', action: 'read', phase: 5, scope: 'tickets',
        summary: 'View files attached to a ticket',
    },
    'support.tickets.attachments.write': {
        family: 'support', action: 'write', phase: 5, scope: 'tickets',
        summary: 'Attach a file to a ticket, or remove one',
    },
    'support.reference.read': {
        family: 'support', action: 'read', phase: 5,
        summary: 'Look up the orders and products a ticket can reference',
    },

    // ═══ CONTENT ═══ 14 legacy endpoints: articles (9) + authors (5) ══════════
    'content.articles.read': {
        family: 'content', action: 'read', phase: 5,
        summary: 'View and preview articles, published or not',
    },
    'content.articles.write': {
        family: 'content', action: 'write', phase: 5,
        summary: 'Create and edit articles',
    },
    'content.articles.publish': {
        family: 'content', action: 'write', phase: 5,
        summary: 'Publish, unpublish and archive articles — this is what the public sees',
    },
    /**
     * ⚠ **A SOFT delete, and only of an article that was never published.**
     *
     * The summary said "permanently delete" until Phase 5 Part A, and it was wrong on both
     * counts: the implementation stamps `deletedAt` and refuses outright once `published_at`
     * is set (`409 BLOG_ARTICLE_DELETE_NOT_ALLOWED`), because an address that has been live
     * may have inbound links and a 404 wastes them. The remedy for a published mistake is
     * `archive`, which keeps the URL answering `410 Gone` with its category hub.
     *
     * `destructive: true` stays, and not because the delete is destructive. The flag's
     * mechanical effect is to keep the name out of `allInFamily()` — which is what withholds
     * it from Support (Phase 17 D-2), the tier that may write prose and may not decide what
     * the public sees.
     */
    'content.articles.delete': {
        family: 'content', action: 'write', phase: 5, destructive: true,
        summary: 'Delete an unpublished article draft — refused once it has ever been published',
    },
    'content.authors.read': {
        family: 'content', action: 'read', phase: 5,
        summary: 'View article authors',
    },
    'content.authors.write': {
        family: 'content', action: 'write', phase: 5,
        summary: 'Create and edit article authors',
    },
    /**
     * Also a soft delete, and **refused while any article credits the byline**
     * (`409 BLOG_AUTHOR_IN_USE`, with the count). That refusal is what keeps `author`
     * non-null on every published article: the public DTO resolves the byline by key, and a
     * dangling reference would put an article carrying `BlogPosting` structured data on the
     * site with no author node at all.
     */
    'content.authors.delete': {
        family: 'content', action: 'write', phase: 5, destructive: true,
        summary: 'Delete an article byline no article credits',
    },

    // ═══ FILES ═══ 2 legacy endpoints, currently guarded inline ═══════════════
    /**
     * Turning a `*FileId` this surface already handed out into something renderable.
     *
     * ── Why it exists, and why it is granted to everyone ────────────────────────
     * Every DTO here ships file references as opaque ids — `logoFileId`, `avatarFileId`,
     * `bannerFileId`, `deliveryProofFileId` — because this service resolves no URLs and
     * must not grow a storage layer (ADR-009 D-6). The contract then told the dashboard
     * to resolve them "against jovi-mall", which the dashboard cannot do: it talks to this
     * service and to nothing else, by design. So every avatar and logo on the admin
     * surface rendered as a placeholder.
     *
     * The read is granted to all three tiers because it discloses nothing new. The caller
     * is already holding the id, which means they already passed the guard on the record
     * that carries it; a file id is a 24-hex value nobody guesses; and the answer is
     * metadata plus a storage URL. Gating it behind `agencies.read` would have meant a
     * `vendors.read` holder could not see a vendor's own logo, and gating it behind all
     * six would have been a permission nobody could name.
     *
     * ⚠️ What keeps that safe is that it RESOLVES and never ENUMERATES. It takes an
     * explicit id set and answers about those; there is no listing form on THIS name and
     * there must not be one. `files.orphans.read` below is the listing, and the point is
     * that it is a separate name — never that the two are interchangeable.
     */
    'files.resolve': {
        family: 'files', action: 'read', phase: 5,
        summary: 'Resolve file ids returned by this service into names, types and URLs',
    },

    /**
     * Retrieving a file's CONTENTS — the bytes, not the metadata (BR-011).
     *
     * ── Why this is not `files.resolve` ───────────────────────────────────────
     * `files.resolve` is held by every tier on a reasoning that is good and does **not**
     * carry over: "the caller is already holding the id, which means they already passed
     * the guard on the record that carried it." That justifies disclosing a *name* and a
     * *size*. It does not justify disclosing **a photograph of somebody's front door**,
     * which is what `shipments/` holds, or a vendor's saleable product file, which is what
     * `digital/` holds. Resolving an id and opening the file are different acts, and this
     * platform already separates acts of that kind — revealing a payout destination is its
     * own permission for exactly this reason.
     *
     * Before this existed there was **no path at all**: a private file resolves with
     * `url: null`, so an operator settling a delivery dispute was told a photograph
     * existed and that they could not look at it.
     *
     * ── Held by Support (tier 3), and the audit is the other half of that ─────
     * Support answers the delivery tickets, and refusing them means every proof-photo
     * ticket escalates to a tier holding no more context than the person already on it.
     * That is the same trade the platform made once already for `agents.tracking.read` —
     * grant it wider, and pay for it with a record. Every use writes an audit row
     * (`files.content.read`), fail-closed: the row commits before the bytes are fetched
     * and a failure of that write is not caught, so with the audit store down nothing is
     * disclosed.
     *
     * ⚠ **No `reason` is required**, unlike the two tracking disclosures. Those answer a
     * question about a person's movements that an operator asks rarely and deliberately;
     * this one is opened repeatedly inside a single dispute, and a reason prompt per image
     * becomes a box somebody types "dispute" into forever. If that turns out to be wrong,
     * the change is additive — the schema gains a field and this note is what to revisit.
     *
     * Neither `destructive` nor flagged `financial`, so `allInFamily('files')` sweeps it
     * into tiers 1 and 2; tier 3 names it explicitly in `TIER_GRANTS`.
     */
    'files.content.read': {
        family: 'files', action: 'read', phase: 6,
        summary: 'Open a file’s contents, including delivery proofs and other private files — every read is recorded in the audit trail',
    },

    /**
     * The listing, and the complement of the resolver above: it answers which files
     * nothing refers to, which is a question no id set can express.
     *
     * ⚠️ **Tiers 1 and 2**, not tier 1 alone — this sentence used to say otherwise and the
     * grant table has always disagreed with it. No flag keeps a read out of
     * `allInFamily('files')`, and `destructive: true` on `files.delete` is what makes the
     * DELETE the tier-1-only half. That split is right rather than accidental: an Admin
     * who can see an orphan and report it, while only a Developer can destroy it, is the
     * ordinary shape of every other destructive name here.
     *
     * Routed at Phase 5 Part B (`GET /api/v1/files/orphans`). The row deliberately
     * withholds the storage key — D-10; the filename is what makes a file judgeable before
     * an unrecoverable delete, and the key is an internal locator that adds nothing to that
     * judgement.
     */
    'files.orphans.read': {
        family: 'files', action: 'read', phase: 5,
        summary: 'List uploaded files no record refers to',
    },

    /**
     * The media library — the SECOND listing on this mount (BR-015).
     *
     * ── Why it is a new name and not `files.resolve` ──────────────────────────
     * The same reason `files.orphans.read` is. `files.resolve` is grantable to every tier
     * on one argument — the caller already holds the id, so nothing new is disclosed — and
     * **that argument does not survive a listing.** A caller who can enumerate does not
     * need to hold an id. The mount's own rule, written when the orphan listing was added,
     * is that a listing here gets its own permission and its own tier; this is the second
     * instance of it rather than a new precedent.
     *
     * ── Tiers 1 and 2, the line `files.orphans.read` already draws ────────────
     * No flag keeps a read out of `allInFamily('files')`, so this is swept into Admin and
     * reaches Support only if somebody names it in `TIER_GRANTS` — and nobody does.
     * Support answers tickets about records they were pointed at; enumerating every file on
     * the platform is not that question, and the orphan listing already settled it.
     *
     * ── NOT audited, and that was a decision rather than an omission (L-5) ────
     * The dashboard asked for an audit row per listing, on the argument that this route
     * discloses something the other four cannot: it ENUMERATES. It was declined, and the
     * test is ADR-006 D-5's own: the exceptions are all "**the output IS the disclosure**"
     * — a payout destination, a live position, a trail, a file's bytes. Metadata about a
     * file fails that test, and `files.orphans.read` already enumerates on this mount
     * unaudited. Auditing a browse surface also dilutes the trail it is meant to protect:
     * an operator paging a media picker would generate more rows in a minute than the
     * disclosures do in a week.
     *
     * ⚠ **Adding the row later is purely additive** — a catalogued action and an
     * `audit:` on the route. If the enumeration argument wins on reflection, this note is
     * what to revisit; nothing here has to be undone first.
     */
    'files.library.read': {
        family: 'files', action: 'read', phase: 6,
        summary: 'Browse every uploaded file on the platform, with its owner and what uses it',
    },

    /**
     * Uploading a file as the administration (BR-015).
     *
     * ── The first WRITE path for files on this service ────────────────────────
     * There has never been one: `README.md` and `files.md` both state that wi-admin accepts
     * no multipart bodies anywhere, so no administrator has ever been able to put a file on
     * the platform through this service. That made four downstream screens impossible — the
     * blog's cover image and image block, the ticket-attachment form, and the media picker
     * they all share.
     *
     * The bytes still land in jovi-mall and jovi-mall still writes the row: this service
     * pipes an unparsed body through and never parses multipart (ADR-021 D-2). What the
     * permission gates is the door, not a storage layer.
     *
     * ── Tiers 1 and 2 ────────────────────────────────────────────────────────
     * Neither `destructive` nor flagged, so `allInFamily('files')` sweeps it into Admin —
     * which is right: writing an article and attaching a document to a ticket are Admin
     * work. Support is not granted it, matching the line the two listings draw. Note
     * Support DOES hold `content.articles.write`, so a Support administrator can edit prose
     * and cannot add a picture to it; that asymmetry is deliberate and is the same one that
     * withholds `content.articles.publish`.
     *
     * ── Audited (L-6), and this one needs no argument ─────────────────────────
     * It is a write, and every write on this service is audited. The row is what says which
     * administrator put a file on the platform — the only record of it, since the file's own
     * `ownerId` is an id in a database that cannot resolve an administrator.
     */
    'files.upload': {
        family: 'files', action: 'write', phase: 6,
        summary: 'Upload a file to the platform as the administration',
    },

    /**
     * The only UNRECOVERABLE operation on this service's whole surface, and the reason the
     * listing above exists.
     *
     * `destructive: true` is doing real work: it is what excludes this from
     * `allInFamily('files')` and therefore from tier 2, and it is why the route requires
     * the file id repeated in the body (D-9, the `outbox.prune` precedent).
     */
    'files.delete': {
        family: 'files', action: 'write', phase: 5, destructive: true,
        summary: 'Permanently delete a file from storage — unrecoverable',
    },

    // ═══ MESSAGING ═══ 1 route, ported at Phase 5 Part C ══════════════════════
    //
    // Renamed from `broadcast` (Phase 5 D-11), and the rename IS the substance. The family
    // has exactly one member, and the old name promised a capability that has never existed
    // anywhere on this platform.

    /**
     * One Telegram message, to one account that has already connected Telegram.
     *
     * ⚠ **The summary is deliberately narrower than the one it replaces.** That read "Send
     * a broadcast message to platform users" and was wrong three times over: there is no
     * audience, no segmentation and no scheduling; jovi-mall's `sendMessage` returns a
     * boolean and keeps no delivery record, so there is nothing to report on afterwards;
     * and the reachable set is not "platform users" but the accounts that linked Telegram
     * through `/connect`. An operator has to be able to tell what a permission does before
     * they are given it, and a name that overstates its blast radius is worse than a vague
     * one — it invites the tier discussion to be had about the wrong capability.
     *
     * Neither `destructive` nor `sensitive`, so `allInFamily('messaging')` sweeps it into
     * tier 2. That is the right grantability: it changes no record and there is nothing to
     * recover. What it IS is un-undoable — the message is read the moment it lands — and
     * that is answered by the audit rather than by a flag: the row carries the recipient
     * and the full body (Phase 5 O-2), because the only useful question about a send
     * nobody can retract is what was said to whom.
     */
    'messaging.telegram.send': {
        family: 'messaging', action: 'write', phase: 5,
        summary: 'Send one Telegram message to one connected account',
    },

    // ═══ USERS ═══ no admin surface today (PHASE-0 §6) ════════════════════════
    'users.read': {
        family: 'users', action: 'read', phase: 6,
        summary: 'Search users across every role and view their detail',
    },
    /**
     * Editing the login identifiers — the only user fields an administrator may change.
     *
     * Deliberately NOT flagged sensitive, after considering it. The flag's mechanical
     * effect is to force a tier to name the permission by hand, and the tier that would
     * have to name it (Admin) is the tier whose job this is: "the customer changed their
     * phone number and cannot sign in" is routine support work, not a privileged act.
     * What contains it instead is that the identifiers are the ONLY writable fields —
     * roles, status and password each need their own permission — and that every edit
     * lands in the audit trail with the previous value in `before`.
     */
    'users.update': {
        family: 'users', action: 'write', phase: 6,
        summary: 'Change a user’s login email or phone number',
    },
    'users.suspend': {
        family: 'users', action: 'write', phase: 6,
        summary: 'Suspend or reinstate a user account, blocking sign-in on every device',
    },
    /**
     * ⚠️ **Declared, and NOT buildable as things stand.** jovi-mall issues stateless JWTs
     * with no session store and no revocation list — `rotateRefreshToken` verifies a
     * signature and mints, so there is nothing to revoke. Forcing a sign-out there means
     * building server-side sessions first, exactly as wi-admin did for its own
     * administrators in Phase 2.
     *
     * The user-management phase shipped without it deliberately and covered the need a
     * different way: `users.suspend` blocks `login`, the refresh rotation AND every
     * authenticated request, so a suspension already ends every live session on the next
     * request. Keep the permission — the surface is real work that will be done — but do
     * not wire a route to it that cannot keep its promise.
     */
    'users.sessions.revoke': {
        family: 'users', action: 'write', phase: 6,
        summary: 'Force a user to sign out of every device',
    },
    /**
     * **Routed as of the dashboard-request round.** It was catalogued-and-unbuilt for the
     * reason recorded here: jovi-mall had no administrator-initiated reset, and issuing a
     * credential needed a delivery channel and an expiry policy neither service had
     * decided on. Both now exist, and the endpoint was built on top of them rather than
     * beside them — `PasswordResetService.issueResetLinkFor` is the same 32-byte token
     * with the same 30 minutes and the same `password_changed_at` revocation the
     * self-service flow already used. It is a third ENTRANCE, not a second mechanism.
     *
     * ⚠️ **Tier 3 must never hold this.** Support answers delivery tickets. A support
     * agent who can mail a working reset link to any vendor can take over any shop, and
     * the audit row would record a routine-looking action. `assertGrantTableValid()` does
     * not catch this on its own — the permission carries no `financial` or `destructive`
     * flag, so the protection is that SUPPORT names its grants by hand and this is not
     * among them.
     *
     * Note it does NOT reset a password: it sends the party a link to set their own. An
     * administrator never learns or chooses the credential, which is the difference from
     * `POST /administrators/:adminId/password-reset` one mount over — that one generates
     * a password and shows it to the operator, because an administrator has no other
     * channel to be reached on.
     */
    'users.password.reset': {
        family: 'users', action: 'write', phase: 6,
        summary: 'Send a user a password-reset link over email, WhatsApp or Telegram',
    },
    /**
     * Sending a customer a passwordless sign-in link.
     *
     * ── Why this is its own permission and not `users.password.reset` ────────────
     * The two look symmetric and are not. A reset link grants nothing until the person
     * chooses a new password, and it evicts every existing session when they do — its
     * worst case is a locked-out user. A sign-in link IS a session: whoever opens the
     * message is signed in as that customer. Collapsing them would mean a tier granted
     * "help people back into their account" silently also got "sign in as a customer",
     * and no audit row would distinguish the two acts.
     *
     * Customers only, enforced in jovi-mall — `MessagingLoginService` scopes every
     * session it mints to `customer` as a literal. A vendor, agency or agent asking for
     * one gets `USER_LOGIN_LINK_ROLE_UNSUPPORTED`.
     *
     * ⚠️ Tier 3 must not hold it, for the same reason as above.
     */
    'users.login_link.send': {
        family: 'users', action: 'write', phase: 6,
        summary: 'Send a customer a passwordless sign-in link over email, WhatsApp or Telegram',
    },
    /**
     * Making the customer bot forget one person's chat, so their next conversation starts
     * fresh.
     *
     * ── Held by ALL THREE tiers, by the owner's decision (2026-09-22) ───────────
     * It is the one `users.*` write Support holds, and the reason is the job. The complaint
     * arrives as a ticket: the bot is confused by something it remembers from an earlier chat.
     * The fix is this button. Withholding it would escalate every such ticket to a tier that
     * knows nothing more about it.
     *
     * ── Why that is safe at tier 3, when the two entries above are not ──────────
     * It changes nothing the platform keeps about the person. No order, message record,
     * account field or credential is touched; only the bot's short conversation memory is
     * dropped, and jovi-mall owns that mechanism. The worst a mistaken or hostile press can do
     * is have one customer's next message answered with no memory of the last chat. Every new
     * customer starts that way. Compare `users.password.reset` and `users.login_link.send`:
     * either one can hand an account to whoever opens the message, which is why Support must
     * never hold them.
     *
     * No flag, on purpose. It is not `destructive` in this catalog's sense, because no record
     * is hard-deleted and nothing cascades. Flagging it would also make the boot assertion
     * refuse it to tier 3, which would overrule the decision above. The audit row limits it
     * instead: every reset is recorded with its actor, and a Support administrator can read
     * that row.
     */
    'users.bot_memory.reset': {
        family: 'users', action: 'write', phase: 6,
        summary: 'Reset the customer bot’s conversation memory for one user, so their next chat starts fresh',
    },
    'users.roles.manage': {
        family: 'users', action: 'write', phase: 6, destructive: true,
        summary: 'Add or remove a user’s platform roles',
    },

    // ═══ VENDORS ═══ all five built ═══════════════════════════════════════════
    // ⚠️ None of these is flagged sensitive, and that is load-bearing rather than an
    // omission. `allInFamily()` EXCLUDES sensitive entries, so flagging one would silently
    // drop it from tier 2's grant — and `assertGrantTableValid()` would not catch it,
    // because tier 1 still holds everything. If a vendor write ever earns a flag, it must
    // also be named by hand in ADMIN's explicit list, beside `audit.export`.
    'vendors.read': {
        family: 'vendors', action: 'read', phase: 6,
        summary: 'Search vendors and view their detail, store, catalogue and settings',
    },
    'vendors.kyc.review': {
        family: 'vendors', action: 'write', phase: 6,
        summary: 'Approve or reject a vendor’s business verification',
    },
    /**
     * Heavier than the name suggests: suspending takes the vendor's whole catalogue off
     * sale in one transaction and blocks their next authenticated request, and reinstating
     * re-runs the activation gate on every listing rather than republishing blindly.
     */
    'vendors.suspend': {
        family: 'vendors', action: 'write', phase: 6,
        summary: 'Suspend or reinstate a vendor, taking their listings off sale',
    },
    /**
     * One listing at a time, under its own suspension reason (`platform_oversight`) so
     * that reinstating the vendor cannot silently republish something an administrator
     * took down on its merits. Editing a vendor's product content is NOT part of this —
     * the catalogue is theirs; this is a takedown lever.
     */
    'vendors.products.manage': {
        family: 'vendors', action: 'write', phase: 6,
        summary: 'Take a vendor’s product off sale, or put it back, as platform oversight',
    },
    /**
     * ⚠️ **Not commission** — the summary used to say so and it was wrong. Commission
     * lives on `PricingPlan.commission_percent` and is set by assigning a plan through
     * jovi-mall's `POST /api/admin/vendors/:vendorId/plan`, behind `billing.subscriptions.assign`.
     *
     * What this governs is the platform-governed slice of `vendor_settings`: the
     * auto-cancel window and the auto-redirect flag and its cap. The rule that decides
     * what belongs there — a setting is the administrator's when its effect lands on
     * somebody other than the vendor — is written out in `UpdateVendorSettingsSchema`.
     */
    'vendors.settings.manage': {
        family: 'vendors', action: 'write', phase: 6,
        summary: 'Change a vendor’s platform-governed order settings — not their commission',
    },

    // ═══ CUSTOMERS ═══ DELETED at Phase 5 Part D — ADR-017 D-1 ═══════════════
    // `customers.read` and `customers.suspend` lived here, catalogued at `phase: 6` under a
    // header that already conceded the point (`no admin surface today`) and GRANTED anyway —
    // tier 2 by `allInFamily('customers')`, tier 3 `customers.read` by name. That is what
    // separated them from the four names on the unbuilt list, which are grants NOBODY HOLDS:
    // a granted permission with no endpoint appears in an administrator's effective list and
    // in the dashboard's permission screen, promising a customers surface that does not exist.
    // Leaving it catalogued with a rationale would have documented the promise rather than
    // withdrawn it.
    //
    // No capability was lost, because the `users` family already covers customers
    // role-agnostically: `GET /users?role=customer` is the directory, `GET /users/:userId`
    // composes the `customer` role-profile, `POST /users/:userId/{suspend,restore}` is the
    // suspension (audited `users.suspend` / `users.reinstate`), and order history is
    // `orders.read?customerId=`. What went is a second name for all of it.
    //
    // The `customers` FAMILY went with them — `permission.types.ts` no longer declares it,
    // because `test-authz.ts` requires every family to hold at least one permission. Building
    // a real customers surface later means re-declaring the family, which is the deliberate
    // edit this deletion exists to force.

    // ═══ SHIPMENTS ═══ no admin surface today ═════════════════════════════════
    'shipments.read': {
        family: 'shipments', action: 'read', phase: 6,
        summary: 'Search shipments and view their detail and assignment state',
    },
    /**
     * The shipment half of the geo-tracker data door (Phase 6.I · ADR-020): one delivery's
     * GPS trail, and its tracking events.
     *
     * ── Why this is a second permission and not `agents.tracking.read` ────────
     * It began as one permission covering the whole door, and the audit catalog's
     * family-consistency assertion refused it — an action named `shipments.*` governed by
     * an `agents.*` permission. That assertion was right about more than naming. The two
     * halves are different exposures and an operator should be able to grant them
     * separately: `agents.tracking.read` is **live surveillance of a person**, this is **a
     * case file about a delivery**, and it is the second that a dispute investigation
     * actually needs.
     *
     * The split also lines this catalog up with geo-tracker's own scope model, which
     * already separates `agent:position` from `shipment:trail` for exactly that reason —
     * so a deployment can hold the trail scope and not the position one, and wi-admin can
     * now express the same policy rather than flattening it.
     *
     * Support holds it, on the same reasoning as `agents.tracking.read`, and the trail read
     * is likewise audited fail-closed before it runs.
     *
     * Deliberately NOT paired with `shipments.read` on its routes, unlike
     * `/:shipmentId/offers` which names `agents.read` beside it. That pattern states a
     * CROSS-FAMILY dependency; every tier holding one of these holds the other, so naming
     * both would be noise rather than a statement.
     */
    'shipments.tracking.read': {
        family: 'shipments', action: 'read', phase: 6,
        summary: 'Read a delivery’s GPS trail and tracking events from geo-tracker — every trail read is recorded in the audit trail',
    },
    'shipments.reassign': {
        family: 'shipments', action: 'write', phase: 6,
        summary: 'Manually move a shipment to a different agent or agency',
    },
    'shipments.cancel': {
        family: 'shipments', action: 'write', phase: 6, destructive: true,
        summary: 'Cancel a shipment already in progress',
    },

    // ═══ ADMINISTRATORS ═══ built in THIS phase ═══════════════════════════════
    // Holding any of these is necessary, never sufficient: escalation.rules.ts refuses
    // self-action and refuses any action on an administrator at or above the caller's own
    // level, whatever they hold.
    'administrators.read': {
        family: 'administrators', action: 'read', phase: 3,
        summary: 'View the administrator directory',
    },
    'administrators.create': {
        family: 'administrators', action: 'write', phase: 3,
        summary: 'Create an administrator account at a level below your own',
    },
    'administrators.update': {
        family: 'administrators', action: 'write', phase: 3,
        summary: 'Edit another administrator’s profile details',
    },
    'administrators.suspend': {
        family: 'administrators', action: 'write', phase: 3, dualControl: ACT_ON_PEER_DEVELOPER,
        summary: 'Suspend or reinstate an administrator, ending all their sessions. '
            + 'Acting on a Developer requires a second Developer’s approval',
    },
    'administrators.tier.set': {
        family: 'administrators', action: 'write', phase: 3,
        escalation: true, dualControl: PROMOTE_TO_DEVELOPER,
        summary: 'Change an administrator’s level. Promoting to Developer requires a second Developer’s approval',
    },
    'administrators.sessions.read': {
        family: 'administrators', action: 'read', phase: 3,
        summary: 'See another administrator’s active sessions',
    },
    'administrators.sessions.revoke': {
        family: 'administrators', action: 'write', phase: 3,
        summary: 'Sign another administrator out of every device',
    },
    'administrators.password.reset': {
        family: 'administrators', action: 'write', phase: 3,
        summary: 'Issue a new one-time password to another administrator, ending all their sessions',
    },
    /**
     * Clear another administrator's two-factor enrolment so they can enrol again.
     *
     * ── Why it exists at all ──────────────────────────────────────────────────
     * Before Phase 12 a lost or wiped authenticator was terminal: re-enrolment 409s once
     * `mfa_enrolled` is set, nothing anywhere cleared it, and MFA is mandatory for the
     * senior tiers — so the account was permanently unusable with no path back short of a
     * database edit. That is a break-glass procedure the service should own rather than
     * leave to whoever has a Mongo shell.
     *
     * ── Why `escalation` rather than a plain write ────────────────────────────
     * It removes the strongest control on the most privileged accounts, and the account it
     * is used on is by definition one nobody can currently authenticate as — the exact
     * shape of a social-engineering target. The flag confines it to tier 1 (asserted at
     * boot) and keeps it out of `allInFamily('administrators')`, so an Admin cannot reach
     * it through a family grant.
     *
     * It does NOT clear a password. Resetting both from one endpoint would hand over an
     * account in a single call; the two are separate acts and stay separate permissions.
     */
    'administrators.mfa.reset': {
        family: 'administrators', action: 'write', phase: 12,
        escalation: true,
        summary: 'Clear another administrator’s two-factor enrolment so they can enrol again',
    },

    /**
     * Turn a `pending` administrator into a working one (ADR-023 D-1).
     *
     * ── Why `escalation`, when activation is not itself a privileged act ──────
     * The flag is doing two mechanical jobs and neither is about seniority. It keeps this
     * name out of `allInFamily('administrators')` — which tier 2 holds — and the boot
     * assertion then confines it to tier 1.
     *
     * Tier 1 is required because activation REQUIRES READING THE EMPLOYEE RECORD, and only
     * tier 1 may read one (`employees.read`). An Admin able to activate would be admitting a
     * person whose file they cannot open: a rubber stamp dressed as a decision, which is the
     * precise defect the applicant-side identity module exists to fix.
     *
     * ── What it is NOT ───────────────────────────────────────────────────────
     * Not dual-controlled. Promotion to Developer is, because it creates a peer who could
     * remove the promoter; activation merely lets somebody hold the level they were CREATED
     * at, and that level was already chosen under `assertMayCreate`.
     *
     * Not a reinstatement. It refuses a suspended account outright — lifting a suspension is
     * `administrators.suspend`, which is dual-controlled on a Developer, and activation must
     * never become a way around that.
     */
    'administrators.activate': {
        family: 'administrators', action: 'write', phase: 23,
        escalation: true,
        summary: 'Activate a pending administrator once their employee record is complete',
    },

    // ═══ EMPLOYEES ═══ the staff record ═══════════════════════════════════════
    //
    // ⚠ **A family of its own, and that is the entire access-control mechanism** (ADR-023 D-2).
    //
    // The obvious design puts these on the `administrators` family beside the directory
    // permissions, and it would be wrong in a way nothing would catch: `tier-grants.ts` gives
    // tier 2 `allInFamily('administrators')`, so the permission that lets an Admin manage the
    // directory would also hand them every colleague's salary, date of birth and home address.
    // `allInFamily()` refuses to expand SENSITIVE entries, so the instinct is to flag these
    // `escalation` and leave them in the family — but `escalation` means "can widen who holds
    // power", and reading somebody's mother's maiden name is not that. Using the flag as a
    // grant-scoping trick would misdescribe the permission in `GET /permissions/catalog`,
    // which administrators read.
    //
    // A separate family says the true thing: this is a different KIND of data, with a
    // different audience, and tier 2 does not hold it.
    //
    // ⚠ **Neither of these is how the SUBJECT reads their own record.** An employee's own
    // record is `selfService` — every administrator may read and write their own, by
    // definition, exactly as `/administrators/me` is. These two are for reading and writing
    // somebody ELSE's.

    /**
     * Read another administrator's employee record — identity, contacts, address, salary.
     *
     * ⚠ **This does NOT disclose the documents themselves**, and the split is deliberate. The
     * record returns file IDS; the bytes need `files.content.read`, which is audited per file
     * and fail-closed. So the picture of somebody holding their identity card is a second,
     * separately-recorded act — a strictly better trail than one row saying "opened the
     * screen", and the reason this read is itself not audited (ADR-023 D-7).
     */
    'employees.read': {
        family: 'employees', action: 'read', phase: 23,
        summary: 'Read another administrator’s employee record — identity, contacts, address and salary',
    },

    /**
     * Write the EMPLOYMENT block of another administrator's record: position, contract,
     * start date, monthly salary.
     *
     * ⚠ **Its scope is narrower than the name suggests, and the narrowness is the point.** It
     * does not grant writing the personal, identity, address, contact or payout halves — those
     * are self-service and have no administrative write path at all. An employee maintains
     * their own facts; the company states the terms it is employing them on. A Developer who
     * could rewrite a colleague's date of birth or payout destination would make the record
     * evidence of nothing.
     *
     * `financial: true` — it sets what a person is paid. That keeps it out of `allInFamily()`
     * belt-and-braces (the family is tier-1-only anyway) and, more usefully, it is TRUE: the
     * flag's own definition is "moves money, or changes a record money is computed from".
     */
    'employees.employment.write': {
        family: 'employees', action: 'write', phase: 23,
        financial: true,
        summary: 'Set another administrator’s position, contract terms and monthly salary',
    },

    // ═══ APPROVALS ═══ built in THIS phase ════════════════════════════════════
    // Approving is not a permission of its own: the approver must hold the permission the
    // PENDING ACTION names (DualControlSpec.approverPermission). This one only opens the
    // queue.
    'approvals.read': {
        family: 'approvals', action: 'read', phase: 3,
        summary: 'View the queue of actions waiting for a second administrator’s approval',
    },

    // ═══ PERMISSIONS ═══ built in THIS phase ══════════════════════════════════
    // The catalog and one's OWN permissions need no permission — see permissions.routes.ts.
    // This covers only the full tier matrix, which is what the administrator-management
    // screen renders.
    'permissions.read': {
        family: 'permissions', action: 'read', phase: 3,
        summary: 'View which permissions each administrator level holds',
    },

    // ═══ AUDIT ═══ Phase 3.5 ══════════════════════════════════════════════════
    // Both said `phase: 7` under a "Phase 3.5" banner until the surface was actually
    // built. `PermissionSpec.phase` was widened to carry 3.5 rather than rounding.
    'audit.read': {
        family: 'audit', action: 'read', phase: 3.5,
        /**
         * Held by ALL THREE tiers. Withholding it from Support would not protect
         * anything — what they may see is decided per row by `auditScopeFilter`, which
         * shows them platform activity and their own actions and hides this service's own
         * machinery. A tier-level refusal would instead deny a Support administrator sight
         * of what was done to the records they are supporting.
         */
        scope: 'audit',
        summary: 'Search the record of every administrator action',
    },
    'audit.export': {
        family: 'audit', action: 'read', phase: 3.5,
        /**
         * `destructive`, and not because exporting destroys anything by itself.
         *
         * Export is the PRECONDITION for deletion: a row can only ever leave the database
         * if it carries an `export_id`, so this is the one permission that can make audit
         * data eligible to be purged. The flag has two mechanical effects, both wanted —
         * `allInFamily()` refuses to sweep it in, so a tier only holds it if someone typed
         * the name, and the boot assertion refuses it to Support outright.
         */
        destructive: true,
        summary: 'Export the audit record for compliance, making exported rows eligible for retention purge',
    },

    // ═══ NOTIFICATIONS ═══ Phase 7 ════════════════════════════════════════════
    'notifications.read': {
        family: 'notifications', action: 'read', phase: 7,
        summary: 'Read the administrator inbox and platform alerts',
    },
    'notifications.manage': {
        family: 'notifications', action: 'write', phase: 7,
        summary: 'Configure which events raise an administrator alert',
    },

    // ═══ SYSTEM ═══ Phase 7 ═══════════════════════════════════════════════════
    'system.health.read': {
        family: 'system', action: 'read', phase: 7,
        summary: 'View database, cache and downstream service health',
    },
    'system.workers.read': {
        family: 'system', action: 'read', phase: 7,
        summary: 'View background worker status and schedules',
    },
    'system.outbox.read': {
        family: 'system', action: 'read', phase: 7,
        summary: 'Inspect the outbound event queue and its depth',
    },
    /**
     * Phase 14 — the two reads the existing `system.*` permissions do not already cover.
     *
     * `/dependencies`, `/integrations` and `/cache` all reuse `system.health.read` (its summary
     * is literally "database, cache and downstream service health"), and `/queues` reuses
     * `system.outbox.read`. Only these two describe something genuinely different.
     */
    'system.metrics.read': {
        family: 'system', action: 'read', phase: 14,
        /**
         * Separate from `system.health.read` on purpose. The metrics projection carries
         * per-route request volumes — order rate, payment rate — which is business information
         * rather than health. Somebody who should see whether Redis is up does not automatically
         * need to see how many orders an hour the platform takes.
         */
        summary: "View the platform service's operational metrics, including per-route request volumes",
    },
    'system.maintenance.read': {
        family: 'system', action: 'read', phase: 14,
        summary: 'View whether the platform is in a maintenance window',
    },

    /**
     * ADR-022 — the Admin rung of the automation-failure ladder.
     *
     * The FAMILY is the enforcement mechanism, exactly as it is for `system.errors.read`
     * below. `tier-grants.ts` gives tier 2 `allInFamily('system')`, so an Admin picks this
     * up automatically and tier 3 does not — Support gets `support.automation.lookup`,
     * which is a genuinely narrower view rather than a smaller page of the same one.
     *
     * Deliberately NOT `system.health.read`. That permission's summary is "database, cache
     * and downstream service health", and a failure feed is neither: it names workflows,
     * nodes and the messages they produced. Somebody who should see whether Redis is up
     * does not automatically need to read the automation layer's internals.
     *
     * ⚠ It stops short of the stack trace, which is tier 1 only via
     * `developer_tools.logs.read`. That split is the reason this feature needs two new
     * names: the boot assertion refuses the `developer_tools` family to any tier but 1, so
     * a single name covering all three rungs is not expressible.
     */
    'system.automation.read': {
        family: 'system', action: 'read', phase: 22,
        summary: 'Investigate automation-layer failures — which workflow, which node, what it reported',
    },

    /**
     * Phase 16 — the middle rung of the error-exposure ladder.
     *
     * The FAMILY is the enforcement mechanism here, which is why the name matters more than
     * it looks. `tier-grants.ts` gives tier 2 `allInFamily('system')`, so an Admin picks
     * this up automatically; tier 3's grants are an explicit list, so Support does NOT — and
     * gets `support.errors.lookup` instead, which is a different, narrower view rather than
     * a smaller helping of this one.
     *
     * Must stay non-sensitive (no financial/escalation/destructive/dualControl flag), or
     * `allInFamily` refuses to expand it and tier 2 silently loses the surface.
     */
    'system.errors.read': {
        family: 'system', action: 'read', phase: 16,
        summary: "Investigate platform errors, including the internal message and unmasked details",
    },

    // ═══ DEVELOPER TOOLS ═══ Phase 7 — Developer tier only ════════════════════
    // Everything here either re-runs a side effect against live data or reveals how the
    // platform is configured. The grant assertion refuses to let any tier but 1 hold one.
    'developer_tools.workers.trigger': {
        family: 'developer_tools', action: 'write', phase: 7, destructive: true,
        summary: 'Run a background worker immediately, against live data',
    },
    'developer_tools.outbox.replay': {
        family: 'developer_tools', action: 'write', phase: 7, destructive: true,
        summary: 'Replay outbound events — downstream services will see them a second time',
    },
    'developer_tools.webhooks.redeliver': {
        family: 'developer_tools', action: 'write', phase: 7, destructive: true,
        summary: 'Redeliver a webhook to a downstream service',
    },
    'developer_tools.catalogue.vectorise': {
        family: 'developer_tools', action: 'write', phase: 7, destructive: true,
        summary: 'Rebuild search vectors for the entire product catalogue',
    },
    'developer_tools.feature_flags.read': {
        family: 'developer_tools', action: 'read', phase: 7,
        summary: 'View feature flag state',
    },
    'developer_tools.feature_flags.set': {
        family: 'developer_tools', action: 'write', phase: 7, destructive: true,
        summary: 'Turn a feature flag on or off for the whole platform',
    },
    'developer_tools.config.read': {
        family: 'developer_tools', action: 'read', phase: 7,
        summary: 'View non-secret runtime configuration',
    },
    /**
     * Phase 14. The most consequential capability on this whole surface: it does not re-run a
     * side effect, it **refuses traffic** — in `down`, all of it.
     *
     * It is also the only tool here whose own failure mode is losing the ability to undo it,
     * which is why `setMaintenance` in the gateway is the one tool that **bypasses the
     * `dev_tools.enabled` feature flag**. Without that carve-out an operator could not enter
     * maintenance during an incident without first turning the flag on, and somebody turning it
     * off mid-window would lock the exit. Same reasoning as the feature-flag routes themselves.
     */
    'developer_tools.maintenance.set': {
        family: 'developer_tools', action: 'write', phase: 14, destructive: true,
        summary: 'Put the platform into or out of a maintenance window, refusing writes or all traffic',
    },
    /**
     * Phase 14. Three of the eight flushable databases are load-bearing for correctness or for
     * money — clearing WhatsApp idempotency keys reopens a duplicate-send window to a real
     * person, and clearing download tokens kills every live customer download link. jovi-mall
     * refuses a whole-database flush on those and returns the blast radius in the response, so
     * it lands in this action's audit row.
     */
    'developer_tools.cache.flush': {
        family: 'developer_tools', action: 'write', phase: 14, destructive: true,
        summary: 'Delete cached keys from a named Redis database on the platform service',
    },

    // ═══ Phase 15 — developer tools ═══════════════════════════════════════════
    //
    // The family is the MECHANISM here, not a label: `assertGrantTableValid()` already refuses
    // any `developer_tools.*` permission to any tier but 1, so tier-1 confinement for all four
    // comes from an existing boot assertion rather than a new rule.

    /**
     * Phase 15. Deliberately NOT `system.logs.read`.
     *
     * `tier-grants.ts` gives tier 2 `allInFamily('system')`, so a `system.*` name would reach the
     * Admin tier — and an unfiltered feed of every warning in the platform is a broader
     * disclosure than any individual `*.read` an Admin holds, because it is not scoped by
     * subject and **cannot** be. A log line is free text: an email in an SMTP failure, a phone
     * number in a WhatsApp send error, an address in a geocoding warning. jovi-mall's scrubber
     * removes credential shapes, never personal data, and deliberately so — redacting all PII
     * from free text would destroy the endpoint's reason to exist.
     *
     * No `destructive` flag: `allInFamily('developer_tools')` is granted to nobody anyway, so
     * the flag would buy nothing and would misdescribe a read. Precedent:
     * `developer_tools.config.read` and `developer_tools.feature_flags.read`.
     */
    'developer_tools.logs.read': {
        family: 'developer_tools', action: 'read', phase: 15,
        summary: "Search the platform service's logs, which are free text and can contain personal data",
    },
    /**
     * Phase 15. Reveals the platform's whole collection map, index topology and row counts —
     * shape information rather than health, which is why it is not `system.health.read`.
     */
    'developer_tools.database.inspect': {
        family: 'developer_tools', action: 'read', phase: 15,
        summary: "Inspect the platform database's collections, sizes and index drift",
    },
    /**
     * Phase 15. Distinct from `cache.flush` because **looking is not clearing** — one permission
     * for both would mean an operator who may inspect may also delete. Key NAMES can embed an
     * id even though values never leave the platform service.
     */
    'developer_tools.cache.inspect': {
        family: 'developer_tools', action: 'read', phase: 15,
        summary: 'List cache key names, types and TTLs in a named Redis database — never their values',
    },
    /**
     * Phase 15. The one new dangerous verb: it deletes rows permanently. Only `sent` rows are
     * eligible — jovi-mall refuses `failed` (the input to `outbox.replay`) and `pending`
     * (undelivered events) outright, and requires the retention age to be repeated as a
     * confirmation.
     */
    'developer_tools.outbox.prune': {
        family: 'developer_tools', action: 'write', phase: 15, destructive: true,
        summary: 'Permanently delete delivered outbound events past a retention age',
    },
} as const satisfies Record<string, PermissionSpec>);

/**
 * Every permission name, as a union type.
 *
 * This is what makes `requirePermission('cod.remittances.confrim')` fail to compile
 * rather than fail closed at runtime on a route nobody tested.
 */
export type PermissionName = keyof typeof PERMISSION_CATALOG;

export const PERMISSION_NAMES = Object.freeze(
    Object.keys(PERMISSION_CATALOG) as PermissionName[],
);

/**
 * A catalog entry, WIDENED to `PermissionSpec`.
 *
 * Always read a spec through this rather than indexing `PERMISSION_CATALOG` directly.
 * `as const` narrows each entry to its own literal shape, so the union has `financial`
 * only on the members that set it — and `spec.financial` on the union does not compile.
 * Widening once here is what lets every consumer ask about a flag uniformly.
 */
export function permissionSpec(name: PermissionName): PermissionSpec {
    return PERMISSION_CATALOG[name];
}

export function isPermissionName(value: unknown): value is PermissionName {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSION_CATALOG, value);
}

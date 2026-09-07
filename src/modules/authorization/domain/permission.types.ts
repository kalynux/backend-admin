/**
 * The vocabulary of authorization.
 *
 * ── Why permissions at all, when the design said tiers ────────────────────────
 * ADR-001 Decision 5 chose a static tier→ENDPOINT map: each route declares `minTier`,
 * and there is no permission catalog. That bought one real property — policy is code, in
 * one file, not runtime-editable data — and gave up granularity to get it.
 *
 * ADR-003 keeps the property and recovers the granularity. Permissions are still code,
 * still frozen, still greppable in one file, and there are still no per-admin overrides
 * and no policy collections. What changes is the unit: a route declares WHAT IT DOES
 * (`cod.remittances.confirm`) rather than WHO MAY REACH IT (`minTier: 2`).
 *
 * That distinction is the whole point. A tier number on a route is a fact about people;
 * a permission name is a fact about the operation, and it stays true when the org chart
 * changes. It also makes the two rules this service must never break expressible:
 *
 *   - a read-family grant can never sweep in a write that moves money (see `financial`
 *     and `allInFamily` in tier-grants.ts)
 *   - holding the permission is necessary, never sufficient — escalation.rules.ts and
 *     resource-scope.ts run after it
 */

/**
 * The top-level grouping. Derived from the verified endpoint census, not invented:
 * ten families cover the 81 endpoints jovi-mall still serves, nine cover the domains
 * PHASE-0 found to have no admin surface at all, and three (`permissions`, `approvals`,
 * `audit`) are this service's own machinery.
 *
 * A family is a coarse bucket for the UI and for `allInFamily()`. It is NOT an
 * authorization unit — nothing is ever granted "the cod family".
 */
export type PermissionFamily =
    // Legacy surface (ported at Phase 5)
    | 'agents'
    | 'agencies'
    | 'billing'
    | 'cod'
    | 'money'
    | 'orders'
    | 'support'
    | 'content'
    | 'files'
    | 'messaging'
    // Domains with no admin surface today (built at Phase 6)
    | 'users'
    | 'vendors'
    // `customers` was here and is DELETED (Phase 5 Part D, ADR-017 D-1). Its two permissions
    // were granted and backed no route, and the `users` family already covers customers
    // role-agnostically. A family must hold at least one permission (`test-authz.ts` § 1), so
    // the family could not outlive them — and should not: re-declaring it is how a real
    // customers surface announces itself.
    | 'shipments'
    | 'administrators'
    | 'notifications'
    | 'system'
    | 'developer_tools'
    // This service's own surfaces
    | 'permissions'
    | 'approvals'
    | 'audit';

export const PERMISSION_FAMILIES: readonly PermissionFamily[] = [
    'agents', 'agencies', 'billing', 'cod', 'money', 'orders', 'support', 'content',
    'files', 'messaging', 'users', 'vendors', 'shipments', 'administrators',
    'notifications', 'system', 'developer_tools', 'permissions', 'approvals', 'audit',
] as const;

/**
 * What the operation does to the world.
 *
 * `approve` is separate from `write` because a four-eyes approver performs the write
 * without ever having requested it — the two are genuinely different acts, and a tier
 * can hold one without the other.
 */
export type PermissionAction = 'read' | 'write' | 'approve';

/**
 * A resource class whose reads are narrowed by WHO is asking, on top of the permission.
 *
 * PHASE-0 found no row-level scoping mechanism anywhere on the platform — this is that
 * mechanism. See resource-scope.ts.
 *
 *  - `tickets` — Support sees its own queue.
 *  - `audit`   — Support sees platform activity and its own actions, never this service's
 *    own machinery. Without the scope, `audit.read` would be a side door onto the
 *    administrator directory that `tier-grants.ts` deliberately withholds from them.
 */
export type ScopedResource = 'tickets' | 'audit';

/**
 * Declares that an action needs a second administrator to commit it.
 *
 * `when` is evaluated against the VALIDATED payload, so a threshold rule reads a number
 * that Zod has already parsed. It is a predicate rather than a boolean because the
 * interesting cases are conditional: promoting to Developer needs four eyes, promoting to
 * Support does not, and both go through the same endpoint.
 */
export interface DualControlSpec {
    /** True → this call is queued for approval instead of executed. */
    when: (payload: Record<string, unknown>) => boolean;
    /**
     * The approver must hold this permission — and must not be the requester. Usually
     * the same permission as the action itself: four eyes means two people who could each
     * have done it alone, not an escalation to someone more senior.
     */
    approverPermission: string;
    /** One line, shown in the pending-approval queue so an approver knows what they are signing. */
    describe: (payload: Record<string, unknown>) => string;
}

export interface PermissionSpec {
    family: PermissionFamily;
    action: PermissionAction;
    /** Rendered by `GET /permissions/catalog`. Written for an administrator, not an engineer. */
    summary: string;

    /**
     * Moves money, changes a record that money is computed from, **or discloses a
     * payment destination**.
     *
     * Two consequences, both mechanical: `allInFamily()` refuses to expand it, so a tier
     * only holds it if someone typed the name; and the grant-table assertion refuses to
     * let tier 3 hold it at all. PHASE-0:274 flagged that `GET /admin/cod/overview` and
     * `POST /admin/cod/deposits` sit behind the identical guard today — this is the flag
     * that stops that from being reproduced here.
     *
     * ── The third clause is Phase 11's, and it is a read ──────────────────────
     * `money.payouts.destination.read` reveals a beneficiary's account number. It moves
     * nothing, so on the first two clauses it would be an ordinary read — and it would
     * then be swept into every tier by `allInFamily('money')`, including Support. The
     * flag is right because its OUTPUT is the material a fraudulent payout instruction
     * is built from, and the same two mechanisms are exactly the ones it needs.
     *
     * The cost of that reuse, stated so the next person does not repeat it by analogy:
     * `financial` now means two things. Do NOT reach for it on a read merely because the
     * read concerns money — `money.earnings.read` and `cod.overview.read` are unflagged
     * and belong that way. Reach for it when disclosing the value is itself the risk.
     */
    financial?: true;

    /**
     * Changes who is an administrator or what level they hold.
     *
     * Tier 1 only, asserted at boot. This is the flag that makes privilege escalation a
     * structural impossibility rather than a code review question.
     */
    escalation?: true;

    /**
     * Irreversible, or reversible only by hand: a hard delete, or a write that cascades
     * across records this service does not own.
     *
     * Excluded from `allInFamily()` for the same reason as `financial` — nobody should
     * acquire it by inheriting a family.
     */
    destructive?: true;

    /** The reads behind this permission are narrowed by `resolveScope()`. */
    scope?: ScopedResource;

    /** Present → the action is queued for a second administrator rather than executed. */
    dualControl?: DualControlSpec;

    /**
     * The phase that builds the surface behind this permission. Documentation only —
     * a permission for an unbuilt endpoint is the POINT of writing the catalog now, so
     * Phase 5 and 6 consume a decided policy instead of inventing one per endpoint.
     */
    phase: 3 | 3.5 | 5 | 6 | 7 | 9 | 11 | 12 | 14 | 15 | 16 | 22;
}

/** The four flags that make a permission too sharp to be granted by a wildcard. */
export const SENSITIVE_FLAGS = ['financial', 'escalation', 'destructive', 'dualControl'] as const;

export function isSensitive(spec: PermissionSpec): boolean {
    return SENSITIVE_FLAGS.some((flag) => spec[flag] !== undefined);
}

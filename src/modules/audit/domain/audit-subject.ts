import { Types } from 'mongoose';
import { AUDIT_TARGET_TYPES, AuditSubjectClass, AuditTargetType } from './audit.types';

/**
 * Who an audit row is about, and therefore who may read it.
 *
 * Pure and DB-free, so `test-audit.ts` can assert the whole policy without Mongo — which
 * matters more here than usual, because the failure mode of a mistake in this file is
 * not an error. It is a tier reading rows it should not.
 */

/**
 * `target_type` → `subject_class`. Exhaustive by construction: `Record<AuditTargetType, …>`
 * means adding a target type without classifying it is a compile error, not a row that
 * quietly falls out of every scope.
 */
const SUBJECT_CLASS: Readonly<Record<AuditTargetType, AuditSubjectClass>> = Object.freeze({
    // The platform's people.
    user: 'platform_actor',
    vendor: 'platform_actor',
    agency: 'platform_actor',
    agent: 'platform_actor',
    customer: 'platform_actor',

    // The platform's records — including the cash chain. Support may read audit for
    // these: they can already read the records themselves, and seeing what was done to
    // a record they support is the point of a support role.
    order: 'platform_record',
    shipment: 'platform_record',
    remittance: 'platform_record',
    deposit: 'platform_record',
    discrepancy: 'platform_record',
    payout: 'platform_record',
    ticket: 'platform_record',
    article: 'platform_record',
    plan: 'platform_record',
    // An uploaded file belongs to a vendor, agency, agent or customer — platform data,
    // not this service's machinery, so it classifies with the records rather than with
    // `internal`. Note this governs who may READ the audit row, which is a separate
    // question from who may perform the delete: `files.delete` is tier-1-only, and
    // Support seeing that a file was removed from a case they are working is the point
    // of the `platform_record` class.
    file: 'platform_record',

    // This service's own machinery. `internal` is the load-bearing value: it is what
    // keeps the administrator directory out of Support's reach through the audit feed,
    // which would otherwise be a side door onto exactly what `tier-grants.ts` withholds.
    administrator: 'internal',
    admin_session: 'internal',
    approval_request: 'internal',
    audit_export: 'internal',
    // Operational machinery, so `internal` — Support sees neither. A flag flip and a worker
    // run say nothing about a platform actor or record, and both reveal how the service is
    // wired, which is the thing `internal` exists to withhold.
    feature_flag: 'internal',
    worker: 'internal',
    // Same class, same argument: a maintenance window is this service's machinery acting on the
    // platform's availability, not a fact about any platform actor or record.
    maintenance_window: 'internal',

    none: 'internal',
});

export function subjectClassOf(target: AuditTargetType): AuditSubjectClass {
    return SUBJECT_CLASS[target];
}

/** Every target type, with its class. Exported for the boot assertion and the tests. */
export function subjectClassTable(): ReadonlyArray<{ target: AuditTargetType; subjectClass: AuditSubjectClass }> {
    return AUDIT_TARGET_TYPES.map((target) => ({ target, subjectClass: SUBJECT_CLASS[target] }));
}

/**
 * The row-level read filter for a given administrator.
 *
 * Tiers 1 and 2 read everything, so they get **no clause at all** rather than a
 * tautological one — an always-true `$or` would still cost the planner a decision.
 *
 * Tier 3 reads two things: anything that is not this service's own machinery, and
 * anything they did themselves. The second branch is what lets a Support administrator
 * see their own account being suspended, which is an `internal` row about them.
 *
 * ── The trade-off recorded here, deliberately ─────────────────────────────────
 * `platform_record` includes the cash chain, so Support can SEE the record of a money
 * action while holding no financial permission to perform one. That was chosen knowingly.
 * It grants no permission, so the boot assertion refusing `financial` to tier 3
 * (`tier-grants.ts`) is untouched — this is a read of history, not a capability.
 */
export function auditScopeFilter(tier: number, adminId: string): Record<string, unknown> | null {
    if (tier <= 2) return null;

    return {
        $or: [
            { subject_class: { $ne: 'internal' } },
            { actor_id: new Types.ObjectId(adminId) },
        ],
    };
}

/**
 * Combine the scope with whatever else a query filters on.
 *
 * **This function exists because of one specific bug it prevents.** The scope is an
 * `$or`, and `matchAnyField` (the shared search helper) also returns an `$or`. The
 * established idiom elsewhere in this service is
 * `Object.assign(filter, matchAnyField(...))` — which, applied here, would overwrite the
 * scope's `$or` with the search's and hand a Support administrator the entire
 * administrator directory the moment they typed anything into a search box.
 *
 * So the two never merge by assignment: every `$or`-shaped clause is collected into an
 * `$and`, where they compose instead of colliding.
 */
export function combineFilters(
    ...clauses: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> {
    const present = clauses.filter(
        (clause): clause is Record<string, unknown> =>
            clause !== null && clause !== undefined && Object.keys(clause).length > 0,
    );

    if (present.length === 0) return {};
    if (present.length === 1) return present[0];

    // Split the clauses that would collide from the ones that cannot. Plain equality
    // fields merge safely; anything using a top-level operator (`$or`, `$and`, `$nor`)
    // goes into the `$and` list, where two of them coexist.
    const merged: Record<string, unknown> = {};
    const conjuncts: Record<string, unknown>[] = [];

    for (const clause of present) {
        const keys = Object.keys(clause);
        const usesOperator = keys.some((key) => key.startsWith('$'));

        if (usesOperator) {
            conjuncts.push(clause);
            continue;
        }

        for (const key of keys) {
            // A field constrained twice is also a collision — keep both rather than
            // letting the later one win silently.
            if (key in merged) {
                conjuncts.push({ [key]: clause[key] });
                continue;
            }
            merged[key] = clause[key];
        }
    }

    if (conjuncts.length === 0) return merged;
    if (Object.keys(merged).length > 0) conjuncts.unshift(merged);

    return conjuncts.length === 1 ? conjuncts[0] : { $and: conjuncts };
}

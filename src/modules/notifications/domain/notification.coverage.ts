import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { PERMISSION_CATALOG, PermissionName } from '../../authorization/domain/permission.catalog';
import { NOTIFICATION_CATALOG } from './notification.catalog';
import { NOTIFICATION_SOURCES } from './source.registry';
import { NOTIFICATION_TYPES, NotificationType } from './notification.types';

/**
 * Boot assertion: every notification type is produced by exactly one source, and every
 * source produces a type that exists.
 *
 * ── Why this is a boot failure and not a test ─────────────────────────────────
 * A declared-but-unproduced notification type is invisible. Nothing throws, no endpoint
 * 500s, the type shows up in the preferences screen and in the `?type=` filter allowlist,
 * and it simply never arrives. That is not a hypothetical failure mode — it is a
 * transcription of one this platform has already shipped twice:
 *
 *  - jovi-mall declared eight `agent_contract.*` situations in a TypeScript union that were
 *    missing from the Mongoose enum. Every one threw `ValidationError` on write, and the
 *    agent was never told (ADR-005 D-17, ADR-008:105).
 *  - This service catalogued `audit.export`, `audit.purge` and the five `approvals.*`
 *    actions from day one and produced none of them. ADR-006 claimed both were audited;
 *    the claim was aspirational for the whole of its life, and Phase 12's fix was exactly
 *    this shape of reverse check (`assertAuditCoverageComplete`).
 *
 * Both were found by reading code, not by anything failing. So the rule is the same one
 * Phase 12 landed on: **a declaration with no producer stops the service from starting**,
 * which is the only outcome nobody can walk past.
 *
 * ── Why "exactly one", not "at least one" ─────────────────────────────────────
 * Two sources producing the same type means two rows for one situation with two different
 * `source_key`s, so the unique index does not collapse them and the administrator is told
 * twice. Idempotency is per (source, row); it cannot protect against a duplicate mapping in
 * the registry, so the mapping is constrained instead.
 *
 * Called from `app.ts`, before `listen`, beside the two audit assertions.
 */
export function assertNotificationCoverageComplete(): void {
    const problems = findCoverageProblems(NOTIFICATION_TYPES, NOTIFICATION_SOURCES);

    if (problems.length > 0) {
        throw createAppError(
            ERROR_CODES.CONFIG_NOTIFICATION_COVERAGE_INCOMPLETE,
            500,
            `Notification coverage is incomplete:\n  - ${problems.join('\n  - ')}`,
        );
    }
}

/** The subset of a source this check reads. Keeps the pure core testable without a registry. */
export interface CoverableSource {
    id: string;
    produces: readonly string[];
}

/**
 * The check itself, as a pure function.
 *
 * Separated from the assertion so the DB-free suite can hand it an ORPHANED type and prove
 * the failure is detected. Asserting only that the shipped registry passes would be a test
 * that cannot fail for the reason it exists: it would stay green if this function were
 * replaced with `return []`, which is exactly the shape of "declared and never written"
 * that Phase 12 found in the audit catalog.
 */
export function findCoverageProblems(
    types: readonly string[],
    sources: readonly CoverableSource[],
): string[] {
    const problems: string[] = [];
    const producers = new Map<string, string[]>();

    for (const source of sources) {
        if (source.produces.length === 0) {
            problems.push(`source "${source.id}" declares no notification type`);
        }

        for (const type of source.produces) {
            if (!types.includes(type)) {
                problems.push(`source "${source.id}" produces "${type}", which is not in NOTIFICATION_TYPES`);
                continue;
            }
            producers.set(type, [...(producers.get(type) ?? []), source.id]);
        }
    }

    for (const type of types) {
        const found = producers.get(type) ?? [];

        if (found.length === 0) {
            problems.push(
                `notification type "${type}" is declared and produced by nothing. `
                + 'Add a source to source.registry.ts, or remove the type. A type with no '
                + 'committed row behind it is a notification nobody will ever receive.',
            );
        } else if (found.length > 1) {
            problems.push(
                `notification type "${type}" is produced by ${found.length} sources `
                + `(${found.join(', ')}). Each type must have exactly one producer, or the same `
                + 'situation is delivered once per source.',
            );
        }

        if (!NOTIFICATION_CATALOG[type as NotificationType]) {
            problems.push(`notification type "${type}" has no entry in NOTIFICATION_CATALOG`);
        }
    }

    // Duplicate source ids would make the watermark documents collide — two sources sharing
    // one cursor, each advancing it past the other's rows.
    const seen = new Set<string>();
    for (const source of sources) {
        if (seen.has(source.id)) problems.push(`duplicate source id "${source.id}"`);
        seen.add(source.id);
    }

    return problems;
}

/**
 * Boot assertion: every permission a source gates on exists and is held by someone.
 *
 * A source whose `requiredPermission` is granted to no tier fans out to nobody. The
 * notification is written by nothing, read by nobody, and looks entirely healthy — the
 * `notifications.manage` shape of problem, one layer down. `assertGrantTableValid` already
 * refuses a permission granted to no tier, so this checks the other half: that the name a
 * source uses is a real catalogued permission at all.
 *
 * Only static audiences can be checked here. `approvals.requested` resolves its permission
 * per row from the queued action's `dualControl` spec, so its correctness is enforced where
 * that lookup happens — `approverPermissionFor` declines a row rather than inventing an
 * audience for it.
 */
export function assertSourcePermissionsExist(): void {
    const unknown = NOTIFICATION_SOURCES
        .filter((source): source is typeof source & { gates: PermissionName } => Boolean(source.gates))
        .filter((source) => !PERMISSION_CATALOG[source.gates])
        .map((source) => `${source.id} → "${source.gates}"`);

    if (unknown.length > 0) {
        throw createAppError(
            ERROR_CODES.CONFIG_NOTIFICATION_COVERAGE_INCOMPLETE,
            500,
            `Notification sources gate on permissions that are not catalogued: ${unknown.join(', ')}`,
        );
    }
}

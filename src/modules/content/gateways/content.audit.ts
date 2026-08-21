import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { auditedAttempt } from '../../audit/domain/audit.writer';

/**
 * Wrap a content write in an audit intent.
 *
 * ── Why this file is in `gateways/` when nothing is delegated ─────────────────
 * Because it occupies the same position every other domain's gateway does — the boundary a
 * write crosses on its way out of this service — and putting it anywhere else would make
 * content the one family where an author has to remember to audit. Every content mutation
 * goes through this function, so a route added later inherits the trail by construction
 * rather than by care. What it does not do is speak HTTP: content writes land in
 * `jovi_mall` through this service's own connection (ADR-004 D-4).
 *
 * ── `auditedAttempt`, not `auditedTransaction`, and that is the interesting part ──
 * The instinct on reading "this service owns the collection" is that the audit row and the
 * change can now commit together, the way an administrator's suspension does. **They
 * cannot.** `infra/mongo/connections.ts` opens TWO MongoClients — one for `wi-admin`, one
 * for `jovi_mall` — and a `ClientSession` belongs to a client. `audit.types.ts` states the
 * consequence at the `external` transport in as many words: *"even a direct write to
 * `jovi_mall` is outside a `wi-admin` session"*.
 *
 * So the shape is the same intent → outcome the delegated families use:
 *
 *   1. the intent row commits FIRST and is awaited — if it fails, the write never happens
 *   2. the write runs
 *   3. the outcome is stamped, with `before` and `after`
 *
 * A crash between 1 and 3 leaves a row at `attempted`, which ADR-002 D4-a calls "itself a
 * useful signal" — resolvable here without a second service to grep, since the article is in
 * a database this process can read.
 *
 * The catalog enforces this rather than trusting it: all nine `content.*` actions are
 * declared `transport: 'external'`, and the writer refuses to record an `external` action
 * through the transactional path.
 *
 * ── Why `before` and `after` are passed in rather than computed ───────────────
 * An article document is up to 400 blocks of prose per language, and an audit trail is read
 * by people. Each caller supplies the small projection worth diffing — status, category,
 * byline, featured, `slug_keys` — and the payload it wants kept. Storing the document would
 * make the row unreadable and the collection large, for a diff nobody could scan.
 */
export async function auditedContentWrite<T>(
    action: AuditAction,
    context: ActorContext,
    target: { id: string; label: string | null },
    payload: Record<string, unknown> | null,
    before: Record<string, unknown> | null,
    perform: () => Promise<{ value: T; after: Record<string, unknown> | null }>,
): Promise<T> {
    return auditedAttempt(
        {
            action,
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            // `article` for authors too — the catalog says why: the target is what an
            // operator searches for, not the row that changed.
            target: { type: 'article', id: target.id, label: target.label },
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload,
        },
        async () => {
            const outcome = await perform();
            return { result: outcome.value, before, after: outcome.after };
        },
    );
}

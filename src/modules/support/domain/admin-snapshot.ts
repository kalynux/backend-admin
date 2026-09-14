import { IAdminAccount } from '../../admin-identity/models/admin-account.model';
import { AdminSnapshotPayload } from '../validators/ticket.validator';

/**
 * An administrator, in the shape jovi-mall stores on a ticket.
 *
 * ── Why this is copied rather than referenced ─────────────────────────────────
 * Administrators live in THIS service's database; tickets live in jovi-mall's. No query
 * joins them, so jovi-mall's `resolveAdmins()` — which looks an id up in its own `admins`
 * collection — finds nothing for a wi-admin id and renders `null` to the customer, vendor,
 * agency or agent reading the ticket. The copy is the only record there will ever be.
 *
 * ── It is built HERE, never taken from a request ──────────────────────────────
 * Nothing a client sends is parsed into this. A client-supplied `name` would let an
 * administrator record somebody else as handling a ticket, and a client-supplied `tier`
 * would decide — through the scope's `alsoTiers` clause — who may subsequently see it. Both
 * come off the `admin_accounts` row.
 *
 * ── `avatar_url` is still always null — and ⚠ THE REASON CHANGED AT ADR-023 ──
 *
 * ⚠ **This docblock said "`admin_accounts` stores no avatar: there is no upload surface for
 * an administrator's own picture". BOTH CLAUSES ARE NOW FALSE.** `admin_accounts` carries
 * `avatar_file_id`, and `PUT /api/v1/employees/me/avatar` sets it. If you are here because
 * you read that sentence somewhere else, it is stale there too.
 *
 * What keeps this field null is now narrower, and it is a genuine gap rather than an absent
 * feature: **the stored field is a URL and this service holds an ID.** Turning one into the
 * other means reading the `jovi_mall.files` row for its `key` and running it through
 * `infra/storage/public-url.ts` — and `snapshotOf` is a synchronous pure function on the
 * ticket-claim path. Making it async and adding a cross-database read to every claim and
 * every assignment is a real change with a real cost, and it was not in ADR-023's scope.
 *
 * ✅ **So this is now a KNOWN FOLLOW-UP rather than a settled non-feature.** Closing it is
 * two changes and neither is difficult: resolve the id here (the media library already builds
 * these URLs locally, BR-015 L-3), or — better — carry `avatar_file_id` in the stored snapshot
 * and let each reader resolve it, which is the rule every other file reference on this
 * platform follows. The second is a jovi-mall change, because the snapshot shape is theirs.
 *
 * An avatar is a `by-type` upload and therefore lands in a PUBLIC tree, so a resolvable URL
 * genuinely exists — this is not blocked on an authorization question.
 *
 * ── What has NOT changed ─────────────────────────────────────────────────────
 * The field stays on the wire as `null`, and sending `''` would still be worse: a client
 * cannot tell "no picture" from "a picture that failed to load". And `avatar_url` remains a
 * field of jovi-mall's `PublicAdminSnapshot` — the projection a customer, vendor, agency or
 * agent is shown — so removing it here would leave jovi-mall still promising it.
 *
 * G-2 (Phase 4, step 4.B.6.1) called the permanently-null field "a promise the API is not
 * keeping". Half of what made that acceptable has now gone away; the promise is one step
 * closer to being keepable and is not kept yet.
 */
export function snapshotOf(account: IAdminAccount): AdminSnapshotPayload {
    return {
        id: account._id.toString(),
        source: 'admin',
        name: account.display_name,
        tier: account.tier,
        job_title: account.job_title ?? null,
        department: account.department ?? null,
        avatar_url: null,
    };
}

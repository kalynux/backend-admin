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
 * ── `avatar_url` is RESERVED and always null, and it is documented as such ────
 * `admin_accounts` stores no avatar: there is no upload surface for an administrator's own
 * picture and no storage decision has been made for one. The field is carried because the
 * stored shape has it and because a customer seeing a face is the point of D-5 — so the day
 * an avatar exists, this is the only line that changes. Sending an empty string instead
 * would be worse: a client cannot tell "no picture" from "a picture that failed to load".
 *
 * G-2 called this "a promise the API is not keeping" and offered two fixes: build the upload
 * surface, or take the field off the wire. **Neither was taken** (Phase 4, step 4.B.6.1;
 * owner decision 2026-08-20), for two reasons the finding did not have:
 *
 *  - wi-admin has **no write-side file surface at all** — its `files` module is two GETs
 *    delegating to jovi-mall, and a grep for `multer` finds nothing. An administrator avatar
 *    would be this service's first upload path: a feature, not a field.
 *  - `avatar_url` is a field of jovi-mall's **`PublicAdminSnapshot`** — the projection a
 *    customer, vendor, agency or agent is shown. Removing it from wi-admin's DTO would leave
 *    jovi-mall still promising it to every non-admin reader.
 *
 * What made a permanently-null field a broken promise is that it was **undocumented**. It is
 * now stated here, on `AdminSnapshotDto.avatarUrl`, and in `docs/api/support.md`.
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

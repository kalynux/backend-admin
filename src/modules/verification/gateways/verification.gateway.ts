import { platformRequest } from '../../../infra/platform/platform.client';
import { ActorContext } from '../../audit/domain/audit-context';

export type VerificationRole = 'vendor' | 'agency' | 'agent';

/**
 * The evidence behind a KYC verdict — identity documents, the applicant's geocoded home, the
 * addresses on the account, and whether anybody has decided yet.
 *
 * ── ⚠ A DELEGATED READ, and ADR-004 D-2 says reads are DIRECT ────────────────
 * This is the exception, and the reason is one this service has already paid for once.
 * Every document here lives in jovi-mall's private `kyc/` storage tree, and the rule that
 * turns a private key into `url: null, access: 'authorized'` is a thing this service holds a
 * **verbatim copy of** (`infra/storage/storage-trees.ts`, BR-015 decision L-3), kept in step
 * by a cross-repo source scan whose own header calls the arrangement *the price of L-3*.
 *
 * That price is worth paying for a media library full of product photographs. It is not
 * worth paying for a photograph of somebody's national identity card: a stale copy of that
 * map publishes a working, permanent, unauthenticated URL to one. So the projection is built
 * once, in the service that owns the rule, and this file carries no knowledge of trees at
 * all.
 *
 * The second reason is smaller and also real: an agency's business addresses live on its
 * **Magazin**, a separate collection, and reading the record directly would mean this service
 * learning that join and getting the Store/Magazin split right in a second place.
 *
 * ── NOT audited, deliberately ────────────────────────────────────────────────
 * This read returns file HANDLES and metadata — no bytes, no image. It is gated on
 * `{vendors,agencies,agents}.read`, the tier-3 lookup permission, for the same reason
 * `files.resolve` is: the caller learns nothing they could not already reach. The audited
 * act is looking at the picture, and that is `files.content.read` on
 * `GET /api/v1/files/:fileId/content`, which already commits its row before the bytes are
 * fetched. Auditing the checklist as well would make every review two rows and tell an
 * investigator nothing the content rows do not.
 *
 * ⚠ **There is no write here.** The verdict is still written where it always was —
 * `POST /api/v1/vendors/:id/kyc/{approve,reject}`, `POST /api/v1/agencies/:id/verify`,
 * `PUT /api/v1/agents/:id/kyc`. A second write path for one field is how two endpoints end
 * up disagreeing about what `legit_verified` means.
 */
export async function verificationRecord(
    role: VerificationRole,
    entityId: string,
    context: ActorContext,
): Promise<unknown> {
    const result = await platformRequest<unknown>({
        method: 'GET',
        path: `/kyc/${role}/${entityId}`,
        actor: context.actor,
        requestId: context.requestId,
    });
    return result.data;
}

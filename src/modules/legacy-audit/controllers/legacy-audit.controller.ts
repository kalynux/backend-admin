import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { sendPaginated } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { LEGACY_ENDPOINT_COUNT } from '../../authorization/domain/legacy-endpoint-map';
import { flagEnabled } from '../../dev-tools/domain/feature-flag.service';
import { LegacyActionReadRepository } from '../repositories/legacy-action.read.repository';
import { toLegacyActionDto } from '../read-models/legacy-action.dto';
import { ListLegacyActionsQuery } from '../validators/legacy-audit.validator';

/**
 * `GET /api/v1/audit/legacy` — administrative actions still performed ON jovi-mall.
 *
 * ── Why a separate endpoint rather than merging into `GET /audit` ─────────────
 * Three reasons, and the first is decisive:
 *
 * 1. **A cross-database union is impossible.** `connections.ts` opens two MongoClients
 *    against two databases, so `$unionWith` cannot reach across. Merging would mean an
 *    application-level merge, which breaks `meta.total` and the stable `{occurred_at, _id}`
 *    ordering that stops a paging client seeing rows twice.
 * 2. **The vocabularies differ.** No `AuditAction`, no `subject_class`, no `sensitive`, and
 *    a different actor id space. Forcing these into `AuditEntryDto` would lie or fill nulls.
 * 3. **It is deleted at cutover.** A separate route is one commit; an untangling is not.
 */

const legacy = new LegacyActionReadRepository();

export class LegacyAuditController {
    /** GET /api/v1/audit/legacy */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListLegacyActionsQuery;

        /**
         * Behind `audit.legacy_feed`, which is on by default.
         *
         * The switch exists for the day the legacy surface goes away: turning it off retires
         * the endpoint ahead of deleting the module, so a dashboard can stop calling it
         * without a coordinated release.
         */
        if (!(await flagEnabled('audit.legacy_feed'))) {
            throw createAppError(
                ERROR_CODES.AUDIT_LEGACY_FEED_DISABLED,
                404,
                'The legacy admin-action feed is switched off',
            );
        }

        const page = await legacy.search(query, identity.tier);

        sendPaginated(res, page.items.map(toLegacyActionDto), {
            ...page.meta,
            /**
             * Every page says what this feed IS, so a dashboard cannot render it as the
             * compliance record by omission.
             */
            legacy: true,
            sourceService: 'jovi-mall',
            retiresAtCutover: true,
            /**
             * How much surface this still covers. When it reaches 0 the legacy admin API is
             * fully ported and both this feed and the shim behind it should be deleted.
             */
            unportedEndpoints: LEGACY_ENDPOINT_COUNT,
        });
    });
}

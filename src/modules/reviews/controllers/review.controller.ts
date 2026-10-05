import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { findCustomerNamesByUserIds } from '../../users/repositories/role-profile.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import { VendorProductReadRepository } from '../../vendors/repositories/vendor-product.read.repository';
import * as gateway from '../gateways/review.gateway';
import { ReviewReadModel, ReviewReadRepository } from '../repositories/review.read.repository';
import {
    ListReviewsQuery,
    RepublishReviewBody,
    ReviewReasonBody,
} from '../validators/review.validator';

const reviews = new ReviewReadRepository();
const products = new VendorProductReadRepository();
const stores = new StoreReadRepository();
const agents = new AgentReadRepository();
const agencies = new AgencyReadRepository();

function toIso(value: Date | string | undefined | null): string | null {
    return value ? new Date(value).toISOString() : null;
}

const hasWords = (value: string | null | undefined): boolean => Boolean(value && value.trim());

/** Every name a page of reviews needs, fetched once per page — never once per row. */
interface NameBook {
    customers: Map<string, string | null>;
    products: Map<string, string | null>;
    stores: Map<string, string | null>;
    agents: Map<string, string | null>;
    agencies: Map<string, string | null>;
}

const idsOf = (rows: ReviewReadModel[], pick: (r: ReviewReadModel) => ObjectId | null | undefined): ObjectId[] => {
    const seen = new Map<string, ObjectId>();
    for (const row of rows) {
        const id = pick(row);
        if (id) seen.set(id.toString(), id);
    }
    return [...seen.values()];
};

async function nameBookFor(rows: ReviewReadModel[]): Promise<NameBook> {
    const [customerNames, productTitles, storeNames, agentNames, agencyNames] = await Promise.all([
        findCustomerNamesByUserIds(idsOf(rows.filter((r) => r.author_role === 'customer'), (r) => r.author_user_id)),
        products.findTitlesByIds(idsOf(rows, (r) => r.target_product_id)),
        stores.findNamesByVendorIds(idsOf(rows, (r) => r.target_vendor_id)),
        agents.findNamesByIds(idsOf(rows, (r) => r.target_agent_id)),
        agencies.findNamesByIds(idsOf(rows, (r) => r.target_agency_id)),
    ]);
    return { customers: customerNames, products: productTitles, stores: storeNames, agents: agentNames, agencies: agencyNames };
}

const ref = (id: ObjectId | null | undefined, names: Map<string, string | null>) =>
    id ? { id: id.toString(), name: names.get(id.toString()) ?? null } : null;

/**
 * Who wrote it, by the name an administrator would recognise. A customer by their own name;
 * a vendor by its SHOP name and an agency by its BUSINESS name — those two only ever review a
 * delivery, and the shop / agency on that delivery is the author's own (eligibility checks it).
 */
function authorName(row: ReviewReadModel, book: NameBook): string | null {
    if (row.author_role === 'customer') return book.customers.get(row.author_user_id.toString()) ?? null;
    if (row.author_role === 'vendor') return row.target_vendor_id ? book.stores.get(row.target_vendor_id.toString()) ?? null : null;
    return row.target_agency_id ? book.agencies.get(row.target_agency_id.toString()) ?? null : null;
}

/**
 * The wire shape.
 *
 * `availableActions` is derived from the STATUS only — which verbs make sense for this review
 * right now. Whether THIS administrator may use them is a separate question answered by their
 * permissions (`reviews.moderate`, `reviews.delete`); a screen needs both.
 *
 * `publiclyVisible` exists because `status: 'published'` is not "anyone can see it": a
 * delivery review is internal and appears on no public page, ever — only its average does.
 */
function toReviewDto(row: ReviewReadModel, book: NameBook) {
    const status = row.status as 'published' | 'unpublished';
    const moderation = row.moderation
        ? {
            action: row.moderation.action ?? null,
            at: toIso(row.moderation.at),
            reason: row.moderation.reason ?? null,
            bySource: row.moderation.by_source ?? null,
            /** A wi-admin administrator id when `bySource` is `admin`. The audit log names them. */
            byAdministratorId: row.moderation.by_source === 'admin' ? row.moderation.by_user_id?.toString() ?? null : null,
        }
        : null;

    return {
        id: row._id.toString(),
        subjectType: row.subject_type,
        status,
        publiclyVisible: row.subject_type === 'product' && status === 'published',
        rating: row.rating,
        title: row.title ?? null,
        body: row.body ?? null,
        hasText: hasWords(row.title) || hasWords(row.body),
        author: {
            userId: row.author_user_id.toString(),
            role: row.author_role,
            name: authorName(row, book),
        },
        product: ref(row.target_product_id, book.products),
        vendor: ref(row.target_vendor_id, book.stores),
        agent: ref(row.target_agent_id, book.agents),
        agency: ref(row.target_agency_id, book.agencies),
        orderId: row.order_id?.toString() ?? null,
        shipmentId: row.shipment_id?.toString() ?? null,
        lastModeration: moderation,
        availableActions: [status === 'published' ? 'unpublish' : 'republish', 'delete'] as const,
        publishedAt: toIso(row.published_at),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
    };
}

async function loadOr404(reviewId: string): Promise<ReviewReadModel> {
    const row = await reviews.findById(reviewId);
    if (!row) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Review not found');
    return row;
}

const snapshotOf = (row: ReviewReadModel) => ({
    status: row.status,
    rating: row.rating,
    subjectType: row.subject_type,
    authorRole: row.author_role,
    title: row.title ?? null,
    body: row.body ?? null,
});

/** The audit row's target label — readable in a list of audit rows without opening each. */
const labelOf = (row: ReviewReadModel) => `${row.rating}★ ${row.subject_type} review by a ${row.author_role}`;

export class ReviewController {
    /** GET /api/v1/reviews — every live review, newest first unless sorted otherwise. */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as ListReviewsQuery;
        const page = await reviews.search(query);
        const book = await nameBookFor(page.items);
        sendPaginated(
            res,
            page.items.map((row) => toReviewDto(row, book)),
            toPageMeta(page.total, page.page, page.limit),
        );
    });

    /** GET /api/v1/reviews/:reviewId */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const row = await loadOr404(req.params.reviewId);
        sendSuccess(res, toReviewDto(row, await nameBookFor([row])));
    });

    /** POST /api/v1/reviews/:reviewId/unpublish — 409 if it is not published. */
    static unpublish = asyncHandler(async (req: Request, res: Response) => {
        const { reason } = req.body as ReviewReasonBody;
        const row = await loadOr404(req.params.reviewId);
        await gateway.unpublish(req.params.reviewId, reason, labelOf(row), snapshotOf(row), actorContextOf(req));
        const fresh = await loadOr404(req.params.reviewId);
        sendSuccess(res, toReviewDto(fresh, await nameBookFor([fresh])), { message: 'Review unpublished' });
    });

    /** POST /api/v1/reviews/:reviewId/republish — 409 if it is not unpublished. */
    static republish = asyncHandler(async (req: Request, res: Response) => {
        const { reason } = req.body as RepublishReviewBody;
        const row = await loadOr404(req.params.reviewId);
        await gateway.republish(req.params.reviewId, reason ?? null, labelOf(row), snapshotOf(row), actorContextOf(req));
        const fresh = await loadOr404(req.params.reviewId);
        sendSuccess(res, toReviewDto(fresh, await nameBookFor([fresh])), { message: 'Review republished' });
    });

    /**
     * DELETE /api/v1/reviews/:reviewId — body `{ reason }`. Any status.
     *
     * Answers `{ id, deleted: true }` rather than the review: it no longer exists on any
     * surface, this one included, and a 404 is the right answer to every later read of it.
     */
    static remove = asyncHandler(async (req: Request, res: Response) => {
        const { reason } = req.body as ReviewReasonBody;
        const row = await loadOr404(req.params.reviewId);
        await gateway.remove(req.params.reviewId, reason, labelOf(row), snapshotOf(row), actorContextOf(req));
        sendSuccess(res, { id: req.params.reviewId, deleted: true }, { message: 'Review deleted' });
    });
}

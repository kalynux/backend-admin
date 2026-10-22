import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import {
    activeBlockOf,
    leadDetailOf,
    leadPageOf,
    leadRowOf,
    listingRefOf,
    loadCustomerOr404,
    loadLeadOr404,
    loadRevealOr404,
} from '../domain/listing-lead-reads';
import { labelOfListing, loadListingOr404, snapshotOfListing } from '../domain/listing-lookup';
import * as gateway from '../gateways/listing-reports.gateway';
import {
    BlockCustomerBody,
    LiftBlockBody,
    ListListingLeadsQuery,
    RefundRevealBody,
} from '../validators/listing-reports.validator';

/**
 * The lead-report half of `/api/v1/listings` (L-25, L-29, L-31): who unlocked a listing's
 * contacts, who that customer really is, and the two things an administrator may do from a
 * provider's report — refund reveals, block the customer on that listing.
 *
 * Reads are direct; every write reads its target first (the 404, the audit label, the
 * `before`), delegates through the audited gateway, and answers with a FRESH read — never
 * with jovi-mall's answer reshaped, so the screen redraws from the database it will read next.
 */

async function blockTargetOf(listingId: string, customerId: string): Promise<gateway.RevealBlockWriteTarget> {
    const [listing] = await Promise.all([loadListingOr404(listingId), loadCustomerOr404(customerId)]);
    const active = await activeBlockOf(listing._id, new ObjectId(customerId));
    return {
        listingId,
        customerId,
        label: labelOfListing(listing),
        before: {
            ...snapshotOfListing(listing),
            customerId,
            activeBlock: active ? { id: active.id, reason: active.reason, ticketId: active.ticketId } : null,
        },
    };
}

/** What a block write answers: this customer's block state on this listing, read back. */
async function freshBlockState(listingId: string, customerId: string) {
    return {
        listingId,
        customerId,
        activeBlock: await activeBlockOf(new ObjectId(listingId), new ObjectId(customerId)),
    };
}

export class ListingReportsController {
    /** GET /api/v1/listings/:listingId/leads — newest first, the customer in full (L-31). */
    static leads = asyncHandler(async (req: Request, res: Response) => {
        const listing = await loadListingOr404(req.params.listingId);
        const page = await leadPageOf(listing, req.query as unknown as ListListingLeadsQuery);
        sendPaginated(res, page.items, toPageMeta(page.total, page.page, page.limit));
    });

    /** GET /api/v1/listings/leads/:leadId — one lead in full, plus the drain-detection view (L-29). */
    static lead = asyncHandler(async (req: Request, res: Response) => {
        const lead = await loadLeadOr404(req.params.leadId);
        sendSuccess(res, await leadDetailOf(lead));
    });

    /**
     * POST /api/v1/listings/reveals/:revealId/refund — body `{ ticketId?, note }`.
     * Answers jovi-mall's numbers beside the lead row read back, refund state included.
     */
    static refund = asyncHandler(async (req: Request, res: Response) => {
        const { revealId } = req.params;
        const { note, ticketId } = req.body as RefundRevealBody;
        const reveal = await loadRevealOr404(revealId);
        const listing = await listingRefOf(reveal.listing_id);
        const listingName = listing?.published?.title || listing?.pending?.title || listing?.slug || reveal.listing_id.toString();

        const result = await gateway.refundReveal(
            {
                revealId,
                label: `${reveal.field} reveal — ${listingName}`,
                before: {
                    leadId: reveal.lead_id.toString(),
                    listingId: reveal.listing_id.toString(),
                    vendorId: reveal.vendor_id.toString(),
                    customerId: reveal.customer_id.toString(),
                    field: reveal.field,
                    cost: reveal.cost,
                    chargedIntoDebt: reveal.charged_into_debt === true,
                    refunded: Boolean(reveal.refund),
                },
            },
            { note, ticketId: ticketId ?? null },
            actorContextOf(req),
        );

        const lead = await loadLeadOr404(reveal.lead_id.toString());
        sendSuccess(res, {
            revealId,
            refundedCredits: typeof result?.refundedCredits === 'number' ? result.refundedCredits : null,
            balanceAfter: typeof result?.balanceAfter === 'number' ? result.balanceAfter : null,
            lead: await leadRowOf(lead),
        }, { message: 'Reveal refunded' });
    });

    /** POST /api/v1/listings/:listingId/reveal-blocks/:customerId — body `{ reason, ticketId? }`. */
    static block = asyncHandler(async (req: Request, res: Response) => {
        const { listingId, customerId } = req.params;
        const { reason, ticketId } = req.body as BlockCustomerBody;
        const target = await blockTargetOf(listingId, customerId);
        await gateway.blockCustomer(target, { reason, ticketId: ticketId ?? null }, actorContextOf(req));
        sendSuccess(res, await freshBlockState(listingId, customerId), { message: 'Customer blocked on this listing' });
    });

    /** DELETE /api/v1/listings/:listingId/reveal-blocks/:customerId — body `{ note? }`. */
    static unblock = asyncHandler(async (req: Request, res: Response) => {
        const { listingId, customerId } = req.params;
        const { note } = (req.body ?? {}) as LiftBlockBody;
        const target = await blockTargetOf(listingId, customerId);
        await gateway.liftBlock(target, note ?? null, actorContextOf(req));
        sendSuccess(res, await freshBlockState(listingId, customerId), { message: 'Block lifted' });
    });
}

import { z } from 'zod';
import { listQuery } from '../../../core/http/list-query';
import { idParam, objectId } from '../../../core/validation/common.schemas';

/**
 * Request shapes for the lead-report half of `/api/v1/listings` — a listing's leads, one lead
 * in full, the reveal refund and the reveal blocks (SERVICE-LISTINGS-PLAN L-25, L-29, L-31,
 * § C-3 internal admin, § C-6).
 */

export const LeadIdParamSchema = idParam('leadId', 'listing lead');
export const RevealIdParamSchema = idParam('revealId', 'listing reveal');

/** `/:listingId/reveal-blocks/:customerId` — the customer is a `customers._id` (§ C-2). */
export const RevealBlockParamsSchema = idParam('listingId', 'listing').merge(idParam('customerId', 'customer'));

/**
 * jovi-mall's vocabularies (`modules/listings/domain/listing.types.ts`), verbatim — no shared
 * package, so `test:listings-reports` reads jovi-mall's file as text and fails if either side
 * moves alone.
 */
export const LISTING_LEAD_CHANNELS = ['web', 'whatsapp', 'telegram'] as const;
export const LISTING_REPORT_WANTS = ['refund', 'check_customer'] as const;

/**
 * The consent states a lead row reports (§ C-3 `VendorLeadRow.consent`), derived from
 * `provider_contact_consents`: granted = `granted_at` set and `revoked_at` not; revoked =
 * `revoked_at` set; anything else — including no row at all — is `not_granted`.
 */
export const PROVIDER_CONSENT_STATES = ['granted', 'not_granted', 'revoked'] as const;

/** Wire name → database path. `listing_leads` uses snake_case timestamps. */
export const LISTING_LEAD_SORT = {
    createdAt: 'created_at',
    windowEnd: 'window_end',
} as const;

/**
 * A listing's leads — newest first by default, which is the order a report is investigated
 * in (and the order the provider's own list uses, so the two screens line up).
 *
 * Built on `listQuery`, so an unknown key is stripped rather than refused — the house rule
 * `test:list-strictness` pins.
 */
export const ListListingLeadsQuerySchema = listQuery(LISTING_LEAD_SORT, '-createdAt');
export type ListListingLeadsQuery = z.infer<typeof ListListingLeadsQuerySchema>;

/** A free-text explanation recorded on the money record or the block: 3–500, trimmed. */
const note = z.string().trim().min(3).max(500);

/**
 * Refund one reveal — `{ ticketId?, note }` exactly as § C-3 takes it. The note is required:
 * a refund moves credits back to a provider, and the reveal row is where the next
 * administrator looks to learn why.
 */
export const RefundRevealSchema = z.object({
    ticketId: objectId.optional(),
    note,
}).strict();
export type RefundRevealBody = z.infer<typeof RefundRevealSchema>;

/** Block one customer on one listing (L-29) — `{ reason, ticketId? }`. */
export const BlockCustomerSchema = z.object({
    reason: note,
    ticketId: objectId.optional(),
}).strict();
export type BlockCustomerBody = z.infer<typeof BlockCustomerSchema>;

/** Lift that block — `{ note? }`. Lifting needs no justification; one may be given. */
export const LiftBlockSchema = z.object({
    note: note.optional(),
}).strict();
export type LiftBlockBody = z.infer<typeof LiftBlockSchema>;

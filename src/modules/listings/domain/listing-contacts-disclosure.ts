import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditIntent } from '../../audit/domain/audit.types';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ListingContactsDto, presentFieldsOf, toListingContactsDto } from '../read-models/listing-contacts.dto';
import { ListingContactReadRepository } from '../repositories/listing-contact.read.repository';
import { labelOfListing, loadListingOr404 } from './listing-lookup';

/**
 * Revealing a service listing's hidden contacts to a reviewer — an audited READ, in exactly the
 * `money.payouts.destination.read` posture (`money/domain/payout-disclosure.ts` argues it at
 * length; the argument transfers whole).
 *
 * ── Why a read is audited ─────────────────────────────────────────────────────
 * The contacts are what a customer spends a provider's credits to see (L-6, L-7), and every
 * tier may look (O-12) because reviewing a listing means checking them against its photos.
 * So "who MAY" is answered generously and the control is "who DID, and how often": a reviewer
 * who opens forty listings' contacts in an afternoon is copying the directory, and only this
 * row would ever show it.
 *
 * ── Why `auditedAttempt`, and why the order is the design ─────────────────────
 * The catalog declares the action `external`. `auditedAttempt` commits the intent FIRST and
 * does not catch that write, so with the audit store unreachable `perform()` never runs and no
 * contact is read, let alone sent. `recordEvent` (best-effort) would be wrong here: the row is
 * the control, not a note about it.
 *
 *   1. read the listing through the PUBLIC projection — 404, and the label. A mistyped id
 *      therefore never reaches the trail as an attempted disclosure; it is not one.
 *   2. commit the intent; stop here if that fails.
 *   3. only now read `listing_contacts`, through the one repository allowed to.
 *   4. stamp `after` with which FIELDS each copy holds — never a value. A number in the audit
 *      store would be readable by anyone holding `audit.read`, without this permission.
 */

const contacts = new ListingContactReadRepository();

export async function revealContacts(listingId: string, context: ActorContext): Promise<ListingContactsDto> {
    const row = await loadListingOr404(listingId);

    const intent: AuditIntent = {
        action: 'catalog.listings.contacts.read',
        actor: auditActorOf(context.actor),
        target: { type: 'listing', id: listingId, label: labelOfListing(row) },
        context,
        /** Whose listing, so the row reads without a join into the other database — nothing else. */
        payload: {
            listingId,
            vendorId: row.vendor_id.toString(),
            status: row.status,
            reviewState: row.review?.state ?? null,
        },
    };

    return auditedAttempt(intent, async () => {
        const found = await contacts.findByListingId(listingId);
        const result = toListingContactsDto(listingId, found);
        return { result, after: { revealedFields: presentFieldsOf(result) } };
    });
}

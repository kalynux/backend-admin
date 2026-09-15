import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { toMongoSort } from '../../../core/data/mongo-list';
import { ListQueryBase } from '../../../core/http/list-query';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { Paginated, PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { PAYOUT_SORT } from '../validators/money.validator';

/**
 * The payout queue — the one place on this surface where money leaves the platform.
 *
 * ── The projection IS the security control, and it is the FIRST of two locks ───
 * `payout_requests.payout_method_snapshot` holds the beneficiary's **plaintext**
 * mobile-money MSISDN or bank account number. It is frozen at request time on purpose, so
 * a later profile edit never redirects money already in flight — which means the
 * collection is a standing roster of where every payout on the platform is addressed.
 *
 * `PAYOUT_LIST_PROJECTION` below is a **dotted whitelist**: it names
 * `payout_method_snapshot.mobile_money.provider` and `.account_name`, and does not name
 * `.phone_number`. The same for `bank.account_number` and `card.gateway_token`. The three
 * values therefore never leave the database on this path — not masked, not truncated,
 * **not read at all**.
 *
 * That is stronger than masking in the mapper, and deliberately so. A masker is a function
 * somebody can forget to call on the next endpoint; a projection is a property of every
 * query this class can run. `read-models/payout-destination.dto.ts` is the second lock, and
 * it is second rather than only.
 *
 * ── What this costs, stated plainly ───────────────────────────────────────────
 * The queue cannot render `••••3456`. Producing a last-four requires the digits, and this
 * class does not have them. An operator recognises a destination here by its **provider and
 * account name** — "MTN · Jean Dupont" — and gets the number from
 * `GET /money/payouts/:payoutId/destination`, which is gated on its own permission and
 * writes an audit row on every read.
 *
 * That is a deliberate tightening over jovi-mall's own admin queue, which still renders the
 * last four (`admin-payout-request.dto.ts`). Both are correct for their surface: jovi-mall's
 * is one screen behind one role, and this service's is the one an auditor asks "who has seen
 * a beneficiary's account number, and when".
 *
 * ── There is no write method, and that is not an oversight ────────────────────
 * Marking a payout paid debits `requested_balance` inside jovi-mall's transaction, resolves
 * the linked support ticket and emits `payout.paid`. `PlatformReadRepository` has no write
 * method, so nothing here could reach that by accident. See `../gateways/money.gateway.ts`.
 *
 * ── The SECOND repository at the bottom of this file ──────────────────────────
 * `PayoutDestinationReadRepository` is the one reader in the service that may see the
 * routing values, and it exists as a separate class rather than a second method here for a
 * structural reason: `PlatformReadRepository` takes ONE projection at construction and
 * applies it to every query it can run. A method that widened the projection for its own
 * use would have to reach around that, and then "the list path cannot leak what it never
 * read" would be a convention instead of a property. Two classes, two projections, and the
 * narrow one is reachable from exactly one route.
 */

export interface PayoutRequestReadModel extends Document {
    _id: ObjectId;
    owner_type: string;
    owner_id: ObjectId;
    amount: number;
    currency: string;
    /**
     * `pending` · `processing` · `paid` · `rejected` · `failed`.
     *
     * ⚠ `processing` and `failed` arrived with gateway transfers and BOTH still hold the
     * owner's money — a failed transfer has not returned anything. Treating either as a
     * finished state is how a balance gets offered twice.
     */
    status: string;
    /** The tier-3 endorsement, or absent. Advisory: it gates nothing. */
    triage?: {
        verdict: string;
        note: string | null;
        by_admin_id: string | null;
        by_name: string | null;
        at: Date | null;
    } | null;
    /** The gateway's own transfer id, for reconciliation. Never our merchant reference. */
    transfer_gateway_ref?: string | null;
    transfer_failure_reason?: string | null;
    /** `manual` (the owner asked) or `auto_threshold` (the platform opened it for them). */
    origin: string;
    /**
     * The destination, **as this projection leaves it**: the method, the labels, and none
     * of the three routing values. See `PAYOUT_LIST_PROJECTION`.
     */
    payout_method_snapshot?: MaskedPayoutMethodSnapshot | null;
    ticket_id?: ObjectId | null;
    requested_by_user_id?: ObjectId | null;
    resolved_at?: Date | null;
    /**
     * Note the field is `resolved_by`, not `resolved_by_user_id` as on `agency_remittances`
     * and `agent_deposits`. That predates jovi-mall's actor-stamp convention and is left
     * alone deliberately — renaming it is a data migration.
     */
    resolved_by?: ObjectId | null;
    /** `'admin'` means the id is a wi-admin one and resolves in NEITHER database's users. */
    resolved_by_source?: string;
    resolved_by_name?: string | null;
    paid_reference?: string | null;
    rejection_reason?: string | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * What survives the projection: every label, no routing value.
 *
 * Typed as its own interface rather than jovi-mall's `IPayoutMethod` because it is
 * genuinely a different shape — the fields that make the other one dangerous are absent
 * here by construction, and a type that still declared them would invite a mapper to read
 * one and find `undefined` at runtime.
 */
export interface MaskedPayoutMethodSnapshot {
    method?: string;
    mobile_money?: { provider?: string; account_name?: string } | null;
    bank?: { bank_name?: string; account_name?: string; country?: string } | null;
    card?: {
        brand?: string;
        /** The only part of a card number jovi-mall stores at all. Never a PAN. */
        last4?: string;
        card_holder_name?: string;
        expiry_month?: number;
        expiry_year?: number;
        issuing_bank?: string | null;
        country?: string;
    } | null;
}

/**
 * The masked-safe whitelist. **Every dotted path here is a deliberate inclusion, and the
 * absences are the point** — see the header.
 *
 * Three names must never appear in this object:
 *   `payout_method_snapshot.mobile_money.phone_number`
 *   `payout_method_snapshot.bank.account_number`
 *   `payout_method_snapshot.card.gateway_token`
 *
 * …and neither must the whole-subdocument forms that would drag them back in
 * (`payout_method_snapshot: 1`, `mobile_money: 1`, `bank: 1`, `card: 1`). `test-money.ts`
 * scans this module's source for all of it, because a projection is a string literal and
 * no compiler checks one.
 *
 * `card.gateway_provider` is omitted too, though it is not a credential — it names which
 * gateway holds the token, and the token is not disclosed here or anywhere. A field with no
 * reader does not belong in a whitelist.
 */
export const PAYOUT_LIST_PROJECTION = {
    _id: 1,
    owner_type: 1,
    owner_id: 1,
    amount: 1,
    currency: 1,
    status: 1,
    origin: 1,
    'payout_method_snapshot.method': 1,
    'payout_method_snapshot.mobile_money.provider': 1,
    'payout_method_snapshot.mobile_money.account_name': 1,
    'payout_method_snapshot.bank.bank_name': 1,
    'payout_method_snapshot.bank.account_name': 1,
    'payout_method_snapshot.bank.country': 1,
    'payout_method_snapshot.card.brand': 1,
    'payout_method_snapshot.card.last4': 1,
    'payout_method_snapshot.card.card_holder_name': 1,
    'payout_method_snapshot.card.expiry_month': 1,
    'payout_method_snapshot.card.expiry_year': 1,
    'payout_method_snapshot.card.issuing_bank': 1,
    'payout_method_snapshot.card.country': 1,
    ticket_id: 1,
    requested_by_user_id: 1,
    /**
     * The reviewer's endorsement. Named field by field like everything else here — a whole
     * sub-document would be one projection entry that grows without anybody re-reading this
     * list, which is the property the whitelist exists to have.
     */
    'triage.verdict': 1,
    'triage.note': 1,
    'triage.by_admin_id': 1,
    'triage.by_name': 1,
    'triage.at': 1,
    /**
     * The gateway transfer.
     *
     * ⛔ `transfer_reference` — the merchant reference we send — is deliberately absent, and
     * for the same reason the routing values above are. It is the idempotency key for money
     * leaving the platform: anything holding it could, in principle, be replayed against the
     * gateway. What reconciles a payout against the NotchPay dashboard is the gateway's own
     * id, which is what these two carry.
     */
    transfer_gateway_ref: 1,
    transfer_failure_reason: 1,
    resolved_at: 1,
    resolved_by: 1,
    resolved_by_source: 1,
    resolved_by_name: 1,
    paid_reference: 1,
    rejection_reason: 1,
    created_at: 1,
    updated_at: 1,
} as const;

export interface PayoutSearchQuery extends ListQueryBase {
    status?: string;
    ownerType?: string;
    ownerId?: string;
    origin?: string;
    from?: Date;
    to?: Date;
    /**
     * Cursor for the account activity feed (`listBefore`). Not reachable from
     * `/money/payouts`, which is offset-paged — `ListPayoutsQuerySchema` does not declare it
     * and is `.strict()`.
     */
    before?: Date;
}

export class PayoutRequestReadRepository extends PlatformReadRepository<PayoutRequestReadModel> {
    constructor() {
        super(COLLECTIONS.PAYOUT_REQUEST, PAYOUT_LIST_PROJECTION);
    }

    async search(query: PayoutSearchQuery): Promise<Paginated<PayoutRequestReadModel>> {
        return this.findPage(buildPayoutFilter(query), {
            page: query.page,
            limit: query.limit,
            sort: toMongoSort(query.sort, PAYOUT_SORT),
        });
    }

    /**
     * One payout, still masked.
     *
     * Every caller in this module goes through here — the detail endpoint, and both writes,
     * which read the row first to refuse a mistyped id with a 404 rather than a wrapped
     * platform error, and to build the audit `before`. **The write path therefore never
     * holds the plaintext destination either**, which is what makes "the disclosure
     * endpoint is the only reader" a property of the module rather than a convention.
     */
    async findById(payoutId: string): Promise<PayoutRequestReadModel | null> {
        if (!Types.ObjectId.isValid(payoutId)) return null;
        return this.findOneBy({ _id: new ObjectId(payoutId) } as Filter<PayoutRequestReadModel>);
    }

    /**
     * One source of the account activity feed — the `payout` category jovi-mall's
     * `VendorTransaction` reserved and never filled.
     *
     * Here rather than in the accounts module because `PAYOUT_LIST_PROJECTION` is declared
     * once and a second reader of this collection would be a second whitelist to keep
     * right — which on THIS collection is the whitelist that keeps a beneficiary's account
     * number in the database. The feed gets rows through the masked projection like every
     * other payout read in the service.
     */
    async listBefore(
        ownerType: string,
        ownerId: string,
        before: Date | undefined,
        limit: number,
    ): Promise<PayoutRequestReadModel[]> {
        return this.findBy(
            buildPayoutFilter({ ownerType, ownerId, before } as PayoutSearchQuery),
            { sort: { created_at: -1, _id: -1 }, limit },
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The disclosure read — the ONE place the routing values leave the database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A payout's destination WITH the digits, for `GET /money/payouts/:payoutId/destination`.
 *
 * ── The labels are the same type the masked path uses ─────────────────────────
 * `payout_method_snapshot` is `MaskedPayoutMethodSnapshot` here too, and that is not a
 * shortcut: the projection below names exactly the same label paths as
 * `PAYOUT_LIST_PROJECTION`, so the two reads produce the same shape and
 * `toRevealedDestinationDto` can build its masked half by delegating to the masked mapper.
 * One label mapper, one place for them to be wrong.
 *
 * ── The two routing values arrive RENAMED, and that is the point ──────────────
 * They are not nested back under the snapshot. See `PAYOUT_DESTINATION_PROJECTION`.
 */
export interface PayoutDestinationReadModel extends Document {
    _id: ObjectId;
    payout_method_snapshot?: MaskedPayoutMethodSnapshot | null;
    /**
     * The MSISDN money is actually sent to — present only when the snapshot holds a
     * mobile-money destination. Absent, never `''`, when it does not.
     */
    revealed_mobile_money_number?: string | null;
    /** The destination bank account number. Same reading. */
    revealed_bank_account_number?: string | null;
}

/**
 * The narrow whitelist behind the disclosure endpoint — **the only projection in this
 * service that names a routing value at all.**
 *
 * ── Why the two values are RENAMED rather than projected in place ─────────────
 * A dotted inclusion (`'payout_method_snapshot.mobile_money.phone_number': 1`) would put
 * the plaintext back inside the snapshot, and then every consumer of it — the read model's
 * type, the DTO mapper, anything that later spreads it — would name the field again. Four
 * mentions across three files, each one a place a grep has to be read carefully.
 *
 * Projecting them to top-level fields of our own naming (MongoDB 4.4+ evaluates
 * `'$path.to.field'` in a `find` projection) collapses that to **one**: the two strings
 * `phone_number` and `account_number` appear exactly once each in `src/modules/money/`,
 * in the object below, and `test-money.ts` §3 asserts precisely that — a scan that used to
 * assert zero and now asserts one, in this block, with everything else still at zero.
 *
 * The rename also makes the values impossible to handle by accident. `revealed_*` is not a
 * field any jovi-mall document has; code touching one is code that meant to.
 *
 * ── `card.gateway_token` is NOT here, and the unmask does not disclose it ─────
 * The need this endpoint serves is "where do I send the money" — an MSISDN or an account
 * number. Nobody sends money *to* a card gateway token; it is a PULL credential, and a card
 * destination's only number is the `last4` the masked path already renders. So a card is
 * fully answered by the labels, `full.card` is typed `null` permanently, and the token stays
 * where it is.
 */
export const PAYOUT_DESTINATION_PROJECTION = {
    _id: 1,
    'payout_method_snapshot.method': 1,
    'payout_method_snapshot.mobile_money.provider': 1,
    'payout_method_snapshot.mobile_money.account_name': 1,
    'payout_method_snapshot.bank.bank_name': 1,
    'payout_method_snapshot.bank.account_name': 1,
    'payout_method_snapshot.bank.country': 1,
    'payout_method_snapshot.card.brand': 1,
    'payout_method_snapshot.card.last4': 1,
    'payout_method_snapshot.card.card_holder_name': 1,
    'payout_method_snapshot.card.expiry_month': 1,
    'payout_method_snapshot.card.expiry_year': 1,
    'payout_method_snapshot.card.issuing_bank': 1,
    'payout_method_snapshot.card.country': 1,
    revealed_mobile_money_number: '$payout_method_snapshot.mobile_money.phone_number',
    revealed_bank_account_number: '$payout_method_snapshot.bank.account_number',
} as const;

/**
 * The disclosure reader. One method, one caller, and both are worth keeping that way.
 *
 * It carries no `search`, no `findPage` and no filter builder — there is no list form of
 * this read and there must not be one. The endpoint above it is audited **per payout**, and
 * a paged version would answer "every beneficiary's account number" behind a single row in
 * the trail, which is the exact shape of the exfiltration the audit row exists to make
 * visible.
 *
 * It also deliberately does not 404: absence is answered by the masked read in
 * `payout-dual-control.ts`, which every payout path already goes through, so a mistyped id
 * fails before the audit intent is even built. What this returning `null` means is narrower
 * and different — the payout exists and has no destination on file (a legacy row predating
 * the snapshot), which the caller turns into `PAYOUT_DESTINATION_ABSENT` (422).
 */
export class PayoutDestinationReadRepository extends PlatformReadRepository<PayoutDestinationReadModel> {
    constructor() {
        super(COLLECTIONS.PAYOUT_REQUEST, PAYOUT_DESTINATION_PROJECTION);
    }

    async findById(payoutId: string): Promise<PayoutDestinationReadModel | null> {
        if (!Types.ObjectId.isValid(payoutId)) return null;
        return this.findOneBy({ _id: new ObjectId(payoutId) } as Filter<PayoutDestinationReadModel>);
    }
}

/**
 * Pure, and exported so `test-money.ts` can assert every branch without a database.
 *
 * There is no `search` term anywhere on this surface: a payout is found by its owner, its
 * state or its window — never by free text — so no `$regex` reaches this collection at all,
 * and the escaping hazard `containsInsensitive` exists for does not arise.
 */
export function buildPayoutFilter(query: PayoutSearchQuery): Filter<PayoutRequestReadModel> {
    const clauses: Record<string, unknown>[] = [];

    if (query.status) clauses.push({ status: query.status });
    if (query.ownerType) clauses.push({ owner_type: query.ownerType });
    if (query.ownerId) clauses.push({ owner_id: toObjectIdOrNothing(query.ownerId) });
    if (query.origin) clauses.push({ origin: query.origin });

    if (query.from || query.to) {
        const range: Record<string, Date> = {};
        if (query.from) range.$gte = query.from;
        // Half-open `[from, to)`, matching `dateRangeFields`.
        if (query.to) range.$lt = query.to;
        clauses.push({ created_at: range });
    }

    /**
     * The account activity feed's cursor — strictly older than, never inclusive. A separate
     * clause from the window above so the two can coexist without either silently
     * overwriting the other's `created_at` key.
     */
    if (query.before) clauses.push({ created_at: { $lt: query.before } });

    if (clauses.length === 0) return {} as Filter<PayoutRequestReadModel>;
    if (clauses.length === 1) return clauses[0] as Filter<PayoutRequestReadModel>;

    return { $and: clauses } as Filter<PayoutRequestReadModel>;
}

/** A malformed id becomes a term that matches nothing, rather than a thrown BSONError. */
function toObjectIdOrNothing(value: string): ObjectId | { $in: [] } {
    return Types.ObjectId.isValid(value) && value.length === 24
        ? new ObjectId(value)
        : { $in: [] };
}

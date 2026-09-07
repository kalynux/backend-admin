import { COLLECTIONS, CollectionName } from './collections';

/**
 * Which collections in the shared `jovi_mall` database this service touches, and how.
 *
 * ── The rule this table encodes (ADR-004 D-2) ─────────────────────────────────
 *
 *   Admin READS `jovi_mall` directly where it needs to.
 *   Admin WRITES `jovi_mall` only through jovi-mall's internal API.
 *   The single exception is the two blog collections, whose ownership moved here.
 *
 * Reads are pure queries with no invariant to protect, so a second reader costs nothing.
 * Writes are where the invariants live — FIFO cash settlement, guarded compare-and-set on
 * balances, the agency deactivation cascade — and every one of them runs inside a Mongo
 * transaction **paired with a post-commit event emission**. A second process can open its
 * own transaction and get the money right while silently getting the notifications wrong.
 * That is the failure this rule exists to prevent, and it is not a failure that shows up
 * in testing.
 *
 * ── Why a table rather than a convention ──────────────────────────────────────
 * Same reason as Phase 3's permission catalog: 81 endpoints arrive at Phase 5, and
 * "remember not to write that one" is not a mechanism. `platform.repository.ts` consumes
 * this table so that a write repository pointed at a `read` collection is a COMPILE error,
 * and the read base has no write method to call in the first place.
 *
 * ── Adding a collection ───────────────────────────────────────────────────────
 * Default to `read`. `owned` means jovi-mall has no code that writes it — verify that by
 * grepping there before claiming it, because the flag is what removes the guard rail.
 *
 * ── One collection is absent ON PURPOSE, and it is the important entry ────────
 * **`user_payment_methods` is deliberately NOT listed** (Phase 11). It holds
 * `gateway_customer_id` and `gateway_instrument_id`, which jovi-mall's own model marks as
 * secrets and protects with a DTO — there is no `select: false` on them, and it would not
 * help here anyway, because this service reads with the raw driver. The same two values
 * are embedded on `customers.saved_payment_methods`, so any future read of `customers`
 * must exclude that path by dotted projection.
 *
 * Leaving it out of this table is not an oversight to be tidied up: `PlatformCollection`
 * is derived from these keys, so a repository cannot be pointed at the collection at all.
 * An administrator has no operational need for a customer's stored instrument — refunds
 * go back to the original payment, and payouts read a destination this service already
 * serves elsewhere, masked. If a genuine need appears, adding the row is the easy half;
 * deciding what may be projected out of it is the part that needs an ADR.
 */

export type CollectionAccess =
    /** Admin may read it. Writes belong to jovi-mall and go over the internal API. */
    | 'read'
    /** Admin owns it outright: jovi-mall no longer writes it, so admin may. */
    | 'owned';

/**
 * Where a write to this collection goes, FROM THIS SERVICE.
 *
 * `'none'` was added in Phase 12 for `admin_action_log`, and it is a real third case rather
 * than a shade of the first: that collection is written by jovi-mall's own `/admin/*`
 * middleware and by nothing else, ever. Labelling it `'internal-api'` would assert there is
 * an endpoint to write it through — there is not, and there must not be, because an HTTP
 * ingest into an audit collection is a forgery surface.
 */
export type CollectionWrite = 'internal-api' | 'direct' | 'none';

export interface PlatformCollectionSpec {
    access: CollectionAccess;
    /** Which service's invariants govern the data. */
    owner: 'jovi-mall' | 'admin';
    /** Where a write goes. `'direct'` is legal only when `access` is `'owned'`. */
    writes: CollectionWrite;
    /** Why this classification — read as the justification, not a description. */
    note: string;
}

export const PLATFORM_COLLECTIONS = Object.freeze({
    // ── Identity and roles ───────────────────────────────────────────────────
    [COLLECTIONS.USER]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Suspension and role changes cascade into sessions and role entities jovi-mall owns',
    },
    [COLLECTIONS.CUSTOMER]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Role entity; created and mutated by the auth and profile paths',
    },
    [COLLECTIONS.VENDOR]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Suspending one takes its whole catalogue off sale in the same transaction',
    },
    [COLLECTIONS.STORE]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'The vendor’s business identity. The slug is globally unique and the storefront routes on it',
    },
    [COLLECTIONS.VENDOR_SETTINGS]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Auto-cancel and auto-redirect drive a platform sweep worker and the agency dispatch path',
    },
    [COLLECTIONS.VENDOR_AGENCY_CONNECTION]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'A status change here suspends and restores products in one transaction',
    },
    [COLLECTIONS.DELIVERY_AGENCY]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Deactivation cascades across vendor products and order items in one transaction',
    },
    [COLLECTIONS.DELIVERY_AGENT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'KYC, ban and tracking state decide whether an agent may be dispatched',
    },
    [COLLECTIONS.ADMIN]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Legacy admin profiles. Retired at cutover — wi-admin owns administrator identity',
    },

    // ── The delivery network (Phase 9) ───────────────────────────────────────
    // An agency's business identity, and the agent↔agency relationship with its history.
    // All three are read for the administrative view of the delivery network; every write
    // is a contract-lifecycle transition jovi-mall's FSM owns.
    [COLLECTIONS.AGENCY_MAGAZIN]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'The agency’s business name, logo and depots — written by onboarding and the magazin profile path',
    },
    [COLLECTIONS.AGENT_AGENCY_CONTRACT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Status transitions run through AgentContractService’s authority matrix and move COD allocation',
    },
    [COLLECTIONS.AGENT_MEMBERSHIP_EVENT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Append-only contract history; rows are written beside each transition inside its transaction',
    },

    // ── Commerce ─────────────────────────────────────────────────────────────
    [COLLECTIONS.ORDER]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Refunds and dispute resolution move money',
    },
    [COLLECTIONS.ORDER_TIMELINE]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Appended by jovi-mall on every order transition',
    },
    [COLLECTIONS.SHIPMENT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Assignment state is coupled to geo-tracker through the outbox',
    },
    [COLLECTIONS.PRODUCT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Product oversight suspends listings the agency cascade also touches',
    },
    [COLLECTIONS.PRODUCT_VARIANT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'The line an order item actually names; its media and price are what a dispute screen has to show (BR-017)',
    },

    // ── Shipment assignment, payments, tracking health (Phase 10) ────────────
    // What a shipment detail needs to answer "why is this delivery stuck", and what an
    // order detail needs to answer "where did the money go". All read; every write on
    // any of them is a transaction this service cannot join.
    [COLLECTIONS.SHIPMENT_ASSIGNMENT_OFFER]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'The offer rows ARE the assignment audit trail; acceptance is a shipment-level compare-and-set',
    },
    [COLLECTIONS.PAYMENT_TRANSACTION]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'The amount snapshot a refund is validated against; written only by the gateway orchestrator',
    },
    [COLLECTIONS.REFUND_TRANSACTION]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Created `pending` BEFORE the gateway call and finalised atomically — never written from here',
    },
    [COLLECTIONS.TRACKING_OUTBOX]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Read for dispatch HEALTH only. The outbox is not transactional with the state it describes',
    },

    /**
     * The interim record of administrative actions still performed ON jovi-mall.
     *
     * `writes: 'none'` — written by jovi-mall's own `/admin/*` middleware and by nothing
     * else. There is no internal-API endpoint to write it through and there must not be: an
     * HTTP ingest into an audit collection would let a caller author audit rows, which is
     * exactly the property `audit.writer.ts` being the only writer exists to guarantee.
     *
     * Read here so `GET /api/v1/audit/legacy` can serve it. NOT merged into `GET /audit` —
     * different vocabulary, different actor id space, and it is deleted at cutover.
     */
    [COLLECTIONS.ADMIN_ACTION_LOG]: {
        access: 'read', owner: 'jovi-mall', writes: 'none',
        note: 'Interim admin-action record on the legacy surface. Deleted at cutover; never the compliance record',
    },

    // ── Cash on delivery ─────────────────────────────────────────────────────
    // Read for the dashboard's own aggregates; every write is delegated. These are the
    // collections where a second writer would be most expensive.
    [COLLECTIONS.AGENCY_REMITTANCE]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Confirming settles collections FIFO inside a transaction',
    },
    [COLLECTIONS.AGENT_DEPOSIT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Recording debits a cash account under a guarded compare-and-set',
    },
    [COLLECTIONS.COD_DISCREPANCY]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Resolution decides who absorbs a shortfall',
    },
    [COLLECTIONS.COD_CASH_ACCOUNT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'The balance the CAS guards. Never written from here',
    },
    [COLLECTIONS.CASH_COLLECTION]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Settled FIFO by remittance confirmation',
    },
    [COLLECTIONS.COD_CASH_LEDGER]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Append-only cash movement, written inside the CAS that moves the balance',
    },
    [COLLECTIONS.COD_TRUST_EVENT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Append-only trust history; the score change and its event commit together',
    },

    // ── Money ────────────────────────────────────────────────────────────────
    [COLLECTIONS.EARNINGS_ACCOUNT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Escrow release is shared with a background worker',
    },
    [COLLECTIONS.EARNINGS_LEDGER]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Append-only ledger written by the earnings services',
    },
    [COLLECTIONS.PAYOUT_REQUEST]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Marking paid records money leaving the platform',
    },
    [COLLECTIONS.EARNINGS_ALLOCATION]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'The unique (source, beneficiary) row every split is computed from; release is shared with a worker',
    },
    [COLLECTIONS.EARNINGS_RESERVE_HOLD]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Agency COD rolling reserve, matured on a schedule this service does not run',
    },

    // ── Billing ──────────────────────────────────────────────────────────────
    [COLLECTIONS.PRICING_PLAN]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Plans are consumed by the entitlement checks on every subscriber path',
    },
    [COLLECTIONS.SUBSCRIBER_PLAN]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Activation emits plan.activated, which resizes agent capacity in-process',
    },
    [COLLECTIONS.CREDIT_WALLET]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Balance guarded by a versioned compare-and-set; debits are metered in-process',
    },
    [COLLECTIONS.CREDIT_TRANSACTION]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Append-only; balance_after is written inside the wallet’s own transaction',
    },
    [COLLECTIONS.CREDIT_TOPUP]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Finalised by the gateway webhook, which credits the wallet in the same step',
    },
    [COLLECTIONS.PLAN_PURCHASE]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Finalised by the gateway webhook; applying it activates a plan and emits plan.activated',
    },
    [COLLECTIONS.BILLING_SETTINGS]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Per-owner notice preference, created lazily by the billing paths',
    },

    // ── Support (Phase 17) ───────────────────────────────────────────────────
    // Four collections, all `read`. A ticket, a note, a follower row and an attachment are
    // RECORDS, and ADR-009 D-1 / ADR-011 D-1 say to read a record directly and delegate only
    // a verdict — there is no verdict on this surface.
    //
    // Every WRITE stays delegated, and here the reason is unusually concrete rather than
    // precautionary: jovi-mall creates tickets in-process from the payout, dispute and
    // booking-refund paths, and every ticket write publishes on its in-process event bus
    // (`ticket.created`, `ticket.assigned`, `ticket.status_changed`, `ticket.priority_changed`).
    // A second writer would move the row and notify nobody — the failure D-2 exists to prevent,
    // and one that does not show up in testing.
    [COLLECTIONS.TICKET]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Rows are created in-process by refund, payout-request and dispute code',
    },
    [COLLECTIONS.TICKET_NOTE]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Includes system notes written beside each transition, and internal notes the customer never sees',
    },
    [COLLECTIONS.TICKET_FOLLOWER]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'The 5-non-admin-follower limit is enforced in jovi-mall’s service, never here',
    },
    [COLLECTIONS.TICKET_ATTACHMENT]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'Rows reference uploaded files; the cleanup worker sweeps them on a terminal-status clock',
    },

    // ── Stored files (BR-015) ────────────────────────────────────────────────
    //
    // The Media library reads both of these DIRECTLY, and that is ADR-009 D-1 applied rather
    // than an exception to it: a file row and a reference row are RECORDS. There is no verdict
    // on this surface at all — nothing here is a decision the platform then acts on.
    //
    // It is also the only way the screen can exist. The listing has to filter by owner, join
    // live reference rows to answer "is this used, and by what", and resolve an owner *name*
    // across five different role collections. jovi-mall's `GET /api/files` does none of those
    // three, so delegating would have meant building the query there and calling it from here —
    // a second endpoint whose only caller is this service, for a read with no invariant.
    //
    // ⚠ **WRITES ARE STILL DELEGATED, and on this pair the reason is concrete rather than
    // precautionary.** Creating a file row is the tail of an upload that also wrote bytes
    // through `STORAGE_PROVIDER`; a reference row is maintained by the file-reference layer,
    // which is what sets and clears `File.orphanedAt`. A second writer here produces a row
    // pointing at no object, or an orphan sweep that reclaims a file something is using. So
    // `POST /api/v1/files/upload` streams to jovi-mall and jovi-mall writes the row (L-2).
    [COLLECTIONS.FILE]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'A stored file is a record. The row is written by the upload pipeline that also put the bytes; `orphanedAt` is maintained by the reference layer',
    },
    [COLLECTIONS.FILE_REFERENCE]: {
        access: 'read', owner: 'jovi-mall', writes: 'internal-api',
        note: 'One live row per (fileId, entityType, entityId, field) — the source of truth for "is this file used". Written beside the entity that uses it, never alone',
    },

    // ── Editorial — the one place ownership moved (ADR-004 D-4) ──────────────
    //
    // Executed at Phase 5 Part A. `ArticleService` and `ArticleAuthorService` are DELETED in
    // jovi-mall, along with the write methods on both its repositories; a source census there
    // finds zero writes to `ArticleModel`/`ArticleAuthorModel` outside `scripts/` (its blog
    // seed and its own verify fixtures, neither a runtime writer).
    //
    // ⚠ **The SCHEMA and the INDEXES did not move, and that asymmetry is the thing to know
    // before editing either side** (Phase 5 plan O-3). jovi-mall keeps `ArticleSchema` and
    // `ArticleAuthorSchema` because its public reader needs them, and `autoIndex` is off in
    // its production config, so the indexes are created from ITS migration ledger — including
    // the unique multikey index on `slug_keys`, which is the only thing enforcing per-locale
    // slug uniqueness. `ensure:indexes` here covers the `wi-admin` database only and must not
    // grow an entry for these two.
    //
    // Two consequences:
    //   - a duplicate slug written from here is refused by an index THIS repository does not
    //     define. `verify:content` proves that rather than assuming it — an index that builds
    //     but does not bind is indistinguishable from one that works.
    //   - a field added to jovi-mall’s `ArticleSchema` without being added to
    //     `domain/article.document.ts` produces documents its public DTO renders wrong, and
    //     no test in either repository would see it. The raw driver applies no defaults.
    [COLLECTIONS.ARTICLE]: {
        access: 'owned', owner: 'admin', writes: 'direct',
        note: 'Writes here (Phase 5 A); SCHEMA + INDEXES stay in jovi-mall for its public reader (O-3)',
    },
    [COLLECTIONS.ARTICLE_AUTHOR]: {
        access: 'owned', owner: 'admin', writes: 'direct',
        // The Mongoose `Map` trap: BSON stores a Map as a plain object, so a real Map handed
        // to the driver stores {} — a byline with no title and no bio, in every language.
        note: 'Writes here alongside articles; schema stays in jovi-mall. Author translations must be written as a PLAIN OBJECT, never a Map',
    },
} as const satisfies Record<string, PlatformCollectionSpec>);

/** A collection this service is allowed to touch at all. */
export type PlatformCollection = keyof typeof PLATFORM_COLLECTIONS;

/**
 * The collections admin may WRITE — the type that makes the rule structural.
 *
 * `PlatformOwnedRepository` takes this as its parameter, so pointing a write repository at
 * `users` does not compile. There is no runtime check because there is no runtime path.
 */
export type OwnedCollection = {
    [K in PlatformCollection]: (typeof PLATFORM_COLLECTIONS)[K]['access'] extends 'owned' ? K : never;
}[PlatformCollection];

export const PLATFORM_COLLECTION_NAMES = Object.freeze(
    Object.keys(PLATFORM_COLLECTIONS) as PlatformCollection[],
);

export function platformCollectionSpec(name: PlatformCollection): PlatformCollectionSpec {
    // Widened on the way out: `as const` narrows each entry to its literal shape, so
    // `spec.access` on the raw union does not compile. Same reasoning as
    // `permissionSpec()` in the authorization catalog.
    return PLATFORM_COLLECTIONS[name];
}

export function isPlatformCollection(value: unknown): value is PlatformCollection {
    return typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(PLATFORM_COLLECTIONS, value);
}

/** Every collection name jovi-mall declares, for the drift check in `test-data-access.ts`. */
export const ALL_KNOWN_COLLECTIONS: readonly CollectionName[] = Object.freeze(
    Object.values(COLLECTIONS) as CollectionName[],
);

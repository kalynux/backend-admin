import { Document, Filter } from 'mongodb';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformCollection } from '../../../infra/platform/platform-collections';
import {
    PermissionName,
    isPermissionName,
    permissionSpec,
} from '../../authorization/domain/permission.catalog';
import { AuditTargetType } from '../../audit/domain/audit.types';
import { APPROVAL_COLLECTION } from '../../dual-control/models/approval-request.model';
import { AUDIT_EXPORT_COLLECTION } from '../../audit/models/audit-export.model';
import {
    NotificationSourceReadRepository,
    SourceCursor,
    withCursor,
} from '../repositories/notification-source.read.repository';
import { adminConnection } from '../../../infra/mongo/connections';
import { NotificationSeverity, NotificationType } from './notification.types';

/**
 * THE SOURCE REGISTRY — every fact the administrator inbox is allowed to carry.
 *
 * ══ The rule this file exists to enforce ══════════════════════════════════════
 *
 * **A notification is derived from a committed row. It is never emitted.**
 *
 * There is no `notify(...)` anywhere in this service that takes a free-form event, and
 * that is the point. Every entry below names a collection, a filter that means *this row
 * is actionable*, and the field whose movement marks the transition. The projector reads
 * rows; it is handed no other way to produce a notification. So a situation the platform
 * does not actually record cannot be notified about — not by convention, but because there
 * is no code path that would accept it.
 *
 * `assertNotificationCoverageComplete()` closes the loop from the other side: a member of
 * `NOTIFICATION_TYPES` that no entry here produces FAILS THE BOOT. Declared-but-unproduced
 * is exactly the state jovi-mall's agent notification types were in — eight situations in
 * the union, absent from the enum, throwing `ValidationError` on every write while looking
 * finished (ADR-005 D-17). Phase 12 built the same reverse check for audit actions
 * (`assertAuditCoverageComplete`) after the same discovery. This is that mechanism, applied
 * one subsystem over.
 *
 * ══ Why row-derived beats event-subscribed here ═══════════════════════════════
 *
 * The obvious design is to subscribe to jovi-mall's domain events, and the blueprint
 * reserved Redis pub/sub (J8) to carry them. Two facts decided against it:
 *
 *  1. jovi-mall's `core/events/event-bus.ts` is an in-process `Map` that awaits handlers
 *     and swallows their errors. The root `CLAUDE.md` already lists the consequence as a
 *     verified defect: an event lost between the commit and the handler is lost
 *     permanently. Adding a Redis hop adds a second place to lose it.
 *  2. The rows are already there, already committed, and already declared readable in
 *     `platform-collections.ts` — `tracking_outbox`'s entry says *"read for dispatch HEALTH
 *     only"*, which is precisely this.
 *
 * The result is a projector that cannot lose anything: a crashed tick re-derives on the
 * next one, and delivery is made exactly-once by the unique `{ source_key, admin_id }`
 * index rather than by careful bookkeeping.
 *
 * ══ Adding a source ═══════════════════════════════════════════════════════════
 *
 *  1. Add the type to `NOTIFICATION_TYPES` and its spec to `NOTIFICATION_CATALOG`.
 *  2. Add one entry here, naming a collection ALREADY in `platform-collections.ts`.
 *  3. That is the whole change. If you skip 2, the service will not start.
 *
 * The collection must already be readable. Widening `platform-collections.ts` to feed the
 * inbox is a decision about data access (ADR-004), not about notifications, and it belongs
 * in that file's review rather than smuggled in beside a `title` string.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who hears about it.
 *
 *  - `permission` — everyone whose tier grants it. The audience is a ROLE, not a list, so
 *    an administrator hired tomorrow is in it and one demoted tomorrow is not.
 *  - `admins` — named recipients, for a fact that is about a person rather than about the
 *    platform: the approval you queued, the export you asked for.
 *
 * There is deliberately no `everyone`. An alert nobody is entitled to act on is noise, and
 * an inbox that carries it teaches administrators to skim.
 */
export type NotificationAudience =
    | { kind: 'permission'; permission: PermissionName }
    | { kind: 'admins'; adminIds: string[] };

/** What a source turns one row into. The projector fans this out; it composes nothing. */
export interface NotificationDraft {
    type: NotificationType;
    /** Overrides the catalog default — a rejection reads differently from an approval. */
    severity?: NotificationSeverity;
    title: string;
    body: string | null;
    audience: NotificationAudience;
    target: { type: AuditTargetType; id: string | null; label: string | null };
    /**
     * This service's own API path for the object.
     *
     * NOT a dashboard route. The dashboard is user-owned and unbuilt (its contract is
     * Phase 8's `admin/api-doc/`), so inventing `/cod/discrepancies/123` as a UI path would
     * be asserting a contract nobody has agreed to. Every path here resolves to a route
     * that exists in `api/index.ts` today, and the dashboard maps it to a screen.
     */
    actionPath: string | null;
    /**
     * The idempotency discriminator, appended to the source id to form `source_key`.
     *
     * Almost always the row id. What it must NOT contain is anything that changes while
     * the situation persists — a timestamp, an attempt count, a status — because that would
     * mint a new key on every sweep and turn the inbox into a log.
     */
    key: string;
    /** When the fact happened, from the row. Never `new Date()`. */
    occurredAt: Date;
}

export interface NotificationSource {
    id: string;
    /** For the ADR and `GET /notifications/sources`. One line, plain. */
    describe: string;
    /** Checked against `NOTIFICATION_TYPES` at boot. */
    produces: readonly NotificationType[];
    /** The collection the facts live in. Stored on every row so provenance survives. */
    collection: string;
    /**
     * The predicate that means *this row is actionable*.
     *
     * Exposed rather than kept inside `fetch` so `verify:notifications` can `explain()` the
     * REAL sweep query. Measuring a synthetic filter instead would report a COLLSCAN this
     * code never runs — and, worse, would miss one it does.
     */
    filter: Filter<Document>;
    /** The field the cursor advances on. Read off the row by the projector. */
    watermarkField: string;
    /**
     * The permission this source's rows are gated on, when it is the same for every row.
     *
     * Redundant with what `toDraft` returns, and deliberately so: an audience buried inside
     * a closure can be read by a person and by nothing else. Declaring it here is what lets
     * `assertSourcePermissionsExist()` check at boot that the name is catalogued, and what
     * lets the ADR table be generated from the code rather than maintained beside it.
     *
     * Absent on the two sources addressed to a named administrator (no permission gates
     * them) and on `approvals.requested` (resolved per row from the queued action's
     * `dualControl` spec).
     */
    gates?: PermissionName;
    fetch(cursor: SourceCursor | null, limit: number): Promise<Document[]>;
    toDraft(row: Document): NotificationDraft | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders
//
// Two, because the two databases are reached two different ways and pretending otherwise
// would mean either giving up the platform read guard or declaring Mongoose schemas for
// collections this service already owns models for.
// ─────────────────────────────────────────────────────────────────────────────

interface PlatformSourceSpec {
    id: string;
    describe: string;
    produces: readonly NotificationType[];
    collection: PlatformCollection;
    projection: Document;
    filter: Filter<Document>;
    watermarkField: string;
    gates?: PermissionName;
    toDraft(row: Document): NotificationDraft | null;
}

/** A source over `jovi_mall`. Read-only by construction — see the repository's header. */
function platformSource(spec: PlatformSourceSpec): NotificationSource {
    // Constructed once, at import. The repository resolves its connection per call, so this
    // does not capture a connection that is not open yet.
    const repository = new NotificationSourceReadRepository(spec.collection, spec.projection);

    return {
        id: spec.id,
        describe: spec.describe,
        produces: spec.produces,
        collection: spec.collection,
        filter: spec.filter,
        watermarkField: spec.watermarkField,
        gates: spec.gates,
        fetch: (cursor, limit) => repository.findSince(spec.filter, spec.watermarkField, cursor, limit),
        toDraft: spec.toDraft,
    };
}

interface AdminSourceSpec {
    id: string;
    describe: string;
    produces: readonly NotificationType[];
    collection: string;
    filter: Filter<Document>;
    watermarkField: string;
    toDraft(row: Document): NotificationDraft | null;
}

/**
 * A source over this service's OWN database.
 *
 * Read through the raw driver on `adminConnection()` rather than the Mongoose models, for
 * one reason: the models are memoised per process and a source that imported
 * `ApprovalRequestModel()` at module load would register the model before `connectAll()`
 * has run. The driver defers everything to call time, exactly as
 * `PlatformReadRepository.collection()` does and for the same reason.
 *
 * No projection is required here — the rows are ours, hold no platform credentials, and the
 * two collections involved are small.
 */
function adminSource(spec: AdminSourceSpec): NotificationSource {
    return {
        id: spec.id,
        describe: spec.describe,
        produces: spec.produces,
        collection: spec.collection,
        filter: spec.filter,
        watermarkField: spec.watermarkField,
        fetch: async (cursor, limit) => {
            const db = adminConnection().db;
            if (!db) return [];

            // `withCursor`, not a second copy of it. The two databases are reached
            // differently but the cursor arithmetic is identical, and it is the part with a
            // sharp edge in it — see `toComparableId`.
            return db
                .collection(spec.collection)
                .find(withCursor(spec.filter, spec.watermarkField, cursor))
                .sort({ [spec.watermarkField]: 1, _id: 1 })
                .limit(limit)
                .toArray();
        },
        toDraft: spec.toDraft,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const idOf = (row: Document): string => String(row._id);

/** Minor units to a readable amount. Currency is stored beside every amount in jovi-mall. */
function money(amount: unknown, currency: unknown): string | null {
    if (typeof amount !== 'number') return null;
    return `${amount.toLocaleString('en-US')} ${String(currency ?? '').toUpperCase()}`.trim();
}

/**
 * Who may approve the action a queued request names.
 *
 * Read from the permission catalog's `dualControl` spec rather than assumed to be the
 * action itself. The two are usually the same — "four eyes means two people who could each
 * have done it alone, not an escalation to someone more senior"
 * (`permission.types.ts:99-102`) — but `approverPermission` is a declared field precisely
 * so a spec can say otherwise, and a copy of that rule here is a copy that drifts. This is
 * the same pairing `approval.routes.ts:49` enforces per request.
 *
 * `null` when the action is not catalogued or carries no `dualControl` spec, which makes
 * the source decline the row rather than guess an audience for it.
 */
function approverPermissionFor(action: unknown): PermissionName | null {
    if (!isPermissionName(action)) return null;

    const approver = permissionSpec(action).dualControl?.approverPermission;
    if (!approver || !isPermissionName(approver)) return null;

    // `approverPermission` is declared `string` on the spec, so `isPermissionName` is a real
    // narrowing rather than a cast. `assertGrantTableValid` already refuses to boot if a
    // spec names an approver permission that does not exist, so in practice this second
    // check never fires — it is here so that the type is earned rather than asserted.
    return approver;
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

export const NOTIFICATION_SOURCES: readonly NotificationSource[] = Object.freeze([

    // ══ Cash on delivery ═════════════════════════════════════════════════════

    platformSource({
        id: 'cod_discrepancy_opened',
        describe: 'An unresolved break in the cash chain',
        produces: ['cod.discrepancy.opened'],
        collection: COLLECTIONS.COD_DISCREPANCY,
        // `opened_at` is `required` with a default on the model, so every row has one.
        watermarkField: 'opened_at',
        gates: 'cod.discrepancies.read',
        filter: { status: 'open' },
        projection: {
            _id: 1, agent_id: 1, agency_id: 1, type: 1, amount: 1, currency: 1,
            status: 1, raised_by: 1, opened_at: 1,
        },
        toDraft: (row) => ({
            type: 'cod.discrepancy.opened',
            title: `Cash discrepancy opened — ${String(row.type).replace(/_/g, ' ')}`,
            body: money(row.amount, row.currency),
            audience: { kind: 'permission', permission: 'cod.discrepancies.read' },
            target: { type: 'discrepancy', id: idOf(row), label: String(row.type) },
            actionPath: `/cod/discrepancies/${idOf(row)}`,
            key: idOf(row),
            occurredAt: row.opened_at as Date,
        }),
    }),

    platformSource({
        id: 'cod_remittance_declared',
        describe: 'An agency remittance awaiting confirmation',
        produces: ['cod.remittance.declared'],
        collection: COLLECTIONS.AGENCY_REMITTANCE,
        watermarkField: 'declared_at',
        gates: 'cod.remittances.read',
        filter: { status: 'declared' },
        projection: { _id: 1, agency_id: 1, amount: 1, currency: 1, status: 1, declared_at: 1 },
        toDraft: (row) => ({
            type: 'cod.remittance.declared',
            title: 'Remittance declared, awaiting confirmation',
            body: money(row.amount, row.currency),
            audience: { kind: 'permission', permission: 'cod.remittances.read' },
            target: { type: 'remittance', id: idOf(row), label: null },
            actionPath: `/cod/remittances/${idOf(row)}`,
            key: idOf(row),
            occurredAt: row.declared_at as Date,
        }),
    }),

    // ══ Money ════════════════════════════════════════════════════════════════

    platformSource({
        id: 'payout_requested',
        describe: 'A payout request that has been neither paid nor rejected',
        produces: ['money.payout.requested'],
        collection: COLLECTIONS.PAYOUT_REQUEST,
        watermarkField: 'created_at',
        gates: 'money.payouts.read',
        filter: { status: 'pending' },
        // `payout_method_snapshot` is DELIBERATELY not projected. It holds plaintext
        // mobile-money MSISDNs and bank account numbers — ADR-011 F-A is the incident where
        // it reached a dashboard — and a notification needs the amount, not the destination.
        projection: { _id: 1, owner_type: 1, owner_id: 1, amount: 1, currency: 1, status: 1, created_at: 1 },
        toDraft: (row) => ({
            type: 'money.payout.requested',
            title: `Payout requested by a ${String(row.owner_type)}`,
            body: money(row.amount, row.currency),
            audience: { kind: 'permission', permission: 'money.payouts.read' },
            target: { type: 'payout', id: idOf(row), label: null },
            actionPath: `/money/payouts/${idOf(row)}`,
            key: idOf(row),
            occurredAt: row.created_at as Date,
        }),
    }),

    // ══ Orders ═══════════════════════════════════════════════════════════════

    platformSource({
        id: 'order_disputed',
        describe: 'An order frozen by a payment dispute',
        produces: ['orders.dispute.opened'],
        collection: COLLECTIONS.ORDER,
        /**
         * `dispute_hold.disputed_at`, and the choice is load-bearing twice over.
         *
         * A dispute flips `payment_status` in place and stamps `dispute_hold`, so there is
         * no insert to watch and `created_at` is the order's, not the dispute's. The obvious
         * substitute is `updated_at` — and it is wrong on both counts. Semantically it moves
         * on every unrelated edit, so it answers "when was this order last touched" rather
         * than "when was it disputed". Mechanically it is UNINDEXED: `verify:notifications`
         * measured a COLLSCAN over the whole of `orders`, which a sweep running every thirty
         * seconds cannot be doing.
         *
         * `dispute_hold.disputed_at` is both the real moment and the key of the partial
         * `dispute_queue` index (`order.model.ts:473`), and the filter below is that index's
         * `partialFilterExpression` exactly — so the sweep reads the handful of frozen
         * orders and touches nothing else.
         */
        watermarkField: 'dispute_hold.disputed_at',
        gates: 'orders.disputes.read',
        /**
         * Deliberately NOT the orders module's two-branch clause.
         *
         * `order.read.repository.ts:268` adds `{ payment_status: 'disputed' }` to catch rows
         * written before `dispute_hold` existed, and that is right for a LIST: a queue that
         * silently omits legacy rows is a queue an administrator cannot trust.
         *
         * It is wrong here, because a notification needs a MOMENT and those rows do not have
         * one. Nothing records when they became disputed, so there is no field to watermark
         * on and no honest `occurredAt` to show; including them would mean either inventing
         * a timestamp or re-reading them on every tick forever. They are also unreachable in
         * practice — the "start at now" rule (`notification.projector.ts`) means nothing that
         * happened before this phase shipped is ever delivered, and every such row is older
         * than that by definition.
         */
        filter: { 'dispute_hold.active': true },
        projection: {
            _id: 1, order_number: 1, payment_status: 1, 'dispute_hold.active': 1,
            'dispute_hold.disputed_at': 1, total: 1, currency: 1,
        },
        toDraft: (row) => {
            const hold = row.dispute_hold as { disputed_at?: Date } | undefined;
            // The partial index guarantees `active: true`, not that the stamp is present.
            // Declining is right: a dispute with no time is one this feed cannot place.
            if (!hold?.disputed_at) return null;

            return {
                type: 'orders.dispute.opened',
                title: `Order ${String(row.order_number ?? idOf(row))} is disputed`,
                body: money(row.total, row.currency),
                audience: { kind: 'permission', permission: 'orders.disputes.read' },
                target: { type: 'order', id: idOf(row), label: (row.order_number as string) ?? null },
                actionPath: `/orders/${idOf(row)}`,
                key: idOf(row),
                occurredAt: hold.disputed_at,
            };
        },
    }),

    // ══ Onboarding awaiting a decision ═══════════════════════════════════════

    platformSource({
        id: 'agency_verification_pending',
        describe: 'A delivery agency awaiting verification',
        produces: ['agencies.verification.pending'],
        collection: COLLECTIONS.DELIVERY_AGENCY,
        watermarkField: 'updated_at',
        // `kyc_details.legit_verified` is the canonical field; the top-level mirror is
        // deprecated (`agency.read.repository.ts:283`). Status is checked too because ADR-009
        // F-2 found every agency is CREATED at `pending_verification` — the pair is what
        // separates "waiting on us" from "already dealt with".
        gates: 'agencies.verify',
        filter: { status: 'pending_verification', 'kyc_details.legit_verified': { $ne: true } },
        projection: {
            _id: 1, display_name: 1, status: 1, country: 1,
            'kyc_details.legit_verified': 1, updated_at: 1,
        },
        toDraft: (row) => ({
            type: 'agencies.verification.pending',
            title: 'Delivery agency awaiting verification',
            body: (row.display_name as string) ?? null,
            audience: { kind: 'permission', permission: 'agencies.verify' },
            target: { type: 'agency', id: idOf(row), label: (row.display_name as string) ?? null },
            actionPath: `/agencies/${idOf(row)}`,
            key: idOf(row),
            occurredAt: (row.updated_at as Date) ?? new Date(0),
        }),
    }),

    platformSource({
        id: 'vendor_kyc_pending',
        describe: 'A vendor awaiting KYC review before they can go live',
        produces: ['vendors.kyc.pending'],
        collection: COLLECTIONS.VENDOR,
        watermarkField: 'updated_at',
        // The same tolerant clause `vendor.read.repository.ts:269` uses: rows written before
        // `kyc_details.status` existed carry only the boolean, and a bare
        // `{ status: 'pending' }` would report the entire pre-existing roster as not pending.
        gates: 'vendors.kyc.review',
        filter: {
            $or: [
                { 'kyc_details.status': 'pending' },
                { 'kyc_details.status': { $exists: false }, 'kyc_details.legit_verified': { $ne: true } },
            ],
        },
        // `display_name`, not a business name: the vendor's trading identity lives on
        // `stores`, and joining a second collection to title a notification is not worth it.
        projection: {
            _id: 1, display_name: 1, 'kyc_details.status': 1,
            'kyc_details.legit_verified': 1, updated_at: 1,
        },
        toDraft: (row) => ({
            type: 'vendors.kyc.pending',
            title: 'Vendor awaiting KYC review',
            body: (row.display_name as string) ?? null,
            audience: { kind: 'permission', permission: 'vendors.kyc.review' },
            target: { type: 'vendor', id: idOf(row), label: (row.display_name as string) ?? null },
            actionPath: `/vendors/${idOf(row)}`,
            key: idOf(row),
            occurredAt: (row.updated_at as Date) ?? new Date(0),
        }),
    }),

    // ══ Platform health ══════════════════════════════════════════════════════

    platformSource({
        id: 'tracking_dispatch_failed',
        describe: 'A lifecycle event that exhausted its retries and never reached geo-tracker',
        produces: ['system.tracking_dispatch.failed'],
        collection: COLLECTIONS.TRACKING_OUTBOX,
        // A row is INSERTED `pending` and only parked as `failed` once attempts hit the max
        // (`tracking-outbox.repository.ts:85`), so `created_at` is the wrong cursor — it
        // would place the row behind the watermark before it ever became interesting.
        watermarkField: 'updated_at',
        gates: 'system.outbox.read',
        filter: { status: 'failed' },
        projection: {
            _id: 1, event_id: 1, type: 1, shipment_id: 1, agent_id: 1,
            status: 1, attempts: 1, last_error: 1, updated_at: 1,
        },
        toDraft: (row) => ({
            type: 'system.tracking_dispatch.failed',
            title: `Tracking event gave up after ${String(row.attempts)} attempts`,
            body: `${String(row.type)} — ${String(row.last_error ?? 'no error recorded')}`,
            audience: { kind: 'permission', permission: 'system.outbox.read' },
            // The outbox is not one of the audit target types and should not become one for
            // this: `none` is the honest classification and the most restrictive one.
            target: { type: 'none', id: String(row.event_id ?? idOf(row)), label: String(row.type) },
            actionPath: '/system/outbox',
            key: idOf(row),
            occurredAt: (row.updated_at as Date) ?? new Date(0),
        }),
    }),

    // ══ This service's own machinery ═════════════════════════════════════════
    //
    // Read from `wi-admin`, by the same mechanism and for the same reason. These could have
    // been written inline at the point the approval is created, and deliberately are not:
    // an inline write is lost if the process dies between the commit and the notify, which
    // is precisely the jovi-mall defect this design exists to avoid. Deriving them keeps
    // ONE producer and one set of guarantees.

    adminSource({
        id: 'approval_requested',
        describe: 'An action queued for a second signature',
        produces: ['approvals.requested'],
        collection: APPROVAL_COLLECTION,
        watermarkField: 'created_at',
        filter: { status: 'pending' },
        toDraft: (row) => {
            const approver = approverPermissionFor(row.action);
            // An action with no `dualControl` spec cannot have reached this collection, so
            // this is a "the catalog changed under a queued row" case, not a normal one.
            // Declining is right: guessing an audience for a queued privileged action is
            // how a notification reaches someone who may not act on it.
            if (!approver) return null;

            return {
                type: 'approvals.requested',
                title: 'An action is waiting for your approval',
                body: (row.description as string) ?? null,
                audience: { kind: 'permission', permission: approver },
                target: { type: 'approval_request', id: idOf(row), label: (row.action as string) ?? null },
                actionPath: `/approvals/${idOf(row)}`,
                key: idOf(row),
                occurredAt: row.created_at as Date,
            };
        },
    }),

    adminSource({
        id: 'approval_decided',
        describe: 'A decision on an approval you requested',
        produces: ['approvals.decided'],
        collection: APPROVAL_COLLECTION,
        // `decided_at` is null while pending, so this source and the one above never see the
        // same row in the same state, and `key` carries the status so a row legitimately
        // produces one of each over its life.
        watermarkField: 'decided_at',
        filter: { status: { $in: ['approved', 'rejected'] }, decided_at: { $ne: null } },
        toDraft: (row) => ({
            type: 'approvals.decided',
            severity: row.status === 'rejected' ? 'warning' : 'info',
            title: `Your queued action was ${String(row.status)}`,
            body: (row.description as string) ?? null,
            audience: { kind: 'admins', adminIds: [String(row.requested_by)] },
            target: { type: 'approval_request', id: idOf(row), label: (row.action as string) ?? null },
            actionPath: `/approvals/${idOf(row)}`,
            key: `${idOf(row)}:${String(row.status)}`,
            occurredAt: row.decided_at as Date,
        }),
    }),

    adminSource({
        id: 'audit_export_finished',
        describe: 'An audit export reaching a terminal state',
        produces: ['audit.export.finished'],
        collection: AUDIT_EXPORT_COLLECTION,
        // An export runs for minutes and is stamped on completion; `updated_at` is what moves
        // when it lands. `created_at` would fire while it was still running.
        watermarkField: 'updated_at',
        filter: { status: { $in: ['complete', 'failed'] } },
        toDraft: (row) => {
            // A CLI export has no requester to tell. Returning null is the sanctioned way for
            // a source to decline a row it matched — the projector skips it and the watermark
            // still advances past it.
            if (!row.requested_by) return null;

            return {
                type: 'audit.export.finished',
                severity: row.status === 'failed' ? 'warning' : 'info',
                title: `Your audit export ${String(row.status) === 'failed' ? 'failed' : 'is ready'}`,
                body: null,
                audience: { kind: 'admins', adminIds: [String(row.requested_by)] },
                target: { type: 'audit_export', id: idOf(row), label: null },
                actionPath: `/audit/exports/${idOf(row)}`,
                key: `${idOf(row)}:${String(row.status)}`,
                occurredAt: (row.updated_at as Date) ?? new Date(0),
            };
        },
    }),
]);

/** Look one up by id — the projector iterates, `/sources` and the tests index. */
export function notificationSource(id: string): NotificationSource | undefined {
    return NOTIFICATION_SOURCES.find((source) => source.id === id);
}

/**
 * Order management — the rules, with no infrastructure.
 *
 * Everything here is a pure function of code: the query schemas, the Mongo filter the list
 * builds, the catalog wiring, and the projections that decide what leaves the database.
 * No Mongo, no Redis, no jovi-mall process.
 *
 * Five sections carry their weight; the rest are guard rails:
 *
 *   §2  the filter composes under `$and`. TWO clauses here are `$or`-shaped — `disputed`
 *       and the search — so merging by assignment would silently drop one and answer a
 *       different question than the one asked.
 *   §3  nothing sensitive leaves. `delivery_address` whole, `.coordinates` and `.raw_input`
 *       are a customer's home; `items.delivery.pickup_location.address_snapshot` is a
 *       vendor's premises. None may appear in any projection.
 *   §4  the order-number search is ANCHORED and case-SENSITIVE, so the unique index serves
 *       it. A `containsInsensitive` here would be a collection scan on the platform's
 *       largest collection, requestable by query string.
 *   §5  every sortable field is backed by an index declared in jovi-mall — a cross-repo
 *       scan, because the two halves of that promise live in different repositories.
 *   §11 jovi-mall actually enforces what this surface delegates, including the three money
 *       defects this phase fixed. A guard that gets "simplified" back is a silent
 *       regression here, not a failing request in production.
 *
 *   npm run test:orders
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { suite, throws } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import {
    CancelOrderSchema,
    ListOrderActivityQuerySchema,
    ListOrderTimelineQuerySchema,
    ORDER_AUDIT_ACTIONS,
    ORDER_SORT,
    RefundOrderSchema,
    ResolveDisputeSchema,
    SearchOrdersQuerySchema,
} from '../../src/modules/orders/validators/order.validator';
import { buildFilter } from '../../src/modules/orders/repositories/order.read.repository';
import { AUDIT_CATALOG } from '../../src/modules/audit/domain/audit.catalog';
import { PERMISSION_CATALOG } from '../../src/modules/authorization/domain/permission.catalog';
import { PLATFORM_COLLECTIONS } from '../../src/infra/platform/platform-collections';
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/orders/routes/order.routes';

const t = suite('order management');

const MODULE = join(__dirname, '..', '..', 'src', 'modules', 'orders');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');

/** Every .ts file in a directory, comments stripped, so a doc comment cannot fail a scan. */
function readCode(dir: string): { file: string; code: string }[] {
    const out: { file: string; code: string }[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...readCode(full));
            continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const raw = readFileSync(full, 'utf8');
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        out.push({ file: full, code });
    }
    return out;
}

const parse = (query: Record<string, unknown>) => SearchOrdersQuerySchema.parse({ ...query });

type AuditSpec = { permission: string | null; target: string; transport: string };
const auditCatalog = AUDIT_CATALOG as unknown as Record<string, AuditSpec>;

type PermissionSpec = { financial?: boolean; family: string };
const permissions = PERMISSION_CATALOG as unknown as Record<string, PermissionSpec>;

type CollectionSpec = { access: string; writes: string };
const collections = PLATFORM_COLLECTIONS as unknown as Record<string, CollectionSpec>;

const files = readCode(MODULE);
const repo = files.find((f) => f.file.endsWith('order.read.repository.ts'))!;

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The list query schema');

t.assert('defaults to newest first', () => parse({}).sort.field === 'createdAt');
t.assert('...descending', () => parse({}).sort.direction === -1);
t.assert('page defaults to 1', () => parse({}).page === 1);
t.assert('limit defaults to 20', () => parse({}).limit === 20);
t.assert('limit is capped at 100', () => throws(() => parse({ limit: '500' })));
t.assert('an unindexed field is not sortable', () => throws(() => parse({ sort: 'totalAmount' })));
t.assert('an unknown sort field is refused', () => throws(() => parse({ sort: 'nope' })));

t.assert('orderType is pinned — a closed two-value set', () => throws(() => parse({ orderType: 'service' })));
t.assert('paymentMethod is pinned', () => throws(() => parse({ paymentMethod: 'crypto' })));

t.assert(
    'paymentStatus is a BOUNDED STRING, not an enum — the vocabulary is jovi-mall’s',
    () => parse({ paymentStatus: 'some_future_status' }).paymentStatus === 'some_future_status',
);
t.assert(
    'AWAITING_PAYMENT passes the bound — the platform really does mix casing',
    () => parse({ paymentStatus: 'AWAITING_PAYMENT' }).paymentStatus === 'AWAITING_PAYMENT',
);
t.assert('a status with a digit is refused', () => throws(() => parse({ paymentStatus: 'paid2' })));
t.assert('a status with a space is refused', () => throws(() => parse({ paymentStatus: 'not paid' })));
t.assert('an over-long status is refused', () => throws(() => parse({ paymentStatus: 'x'.repeat(41) })));

t.assert('vendorId must be an ObjectId', () => throws(() => parse({ vendorId: 'nope' })));
t.assert(
    'a date range beyond 366 days is refused',
    () => throws(() => parse({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The filter composes under $and — two $or-shaped clauses');

t.assert('an empty query is an empty filter', () => Object.keys(buildFilter(parse({}))).length === 0);
t.assert('one clause is returned bare, not wrapped', () => !('$and' in buildFilter(parse({ paymentStatus: 'paid' }))));

t.assert(
    'two $or-shaped clauses produce an $and',
    () => Array.isArray((buildFilter(parse({ disputed: 'true', search: 'ORD-2026' })) as { $and?: unknown[] }).$and),
);
t.assert('BOTH $or clauses survive — neither overwrote the other', () => {
    const both = buildFilter(parse({ disputed: 'true', search: 'ORD-2026' })) as { $and: Record<string, unknown>[] };
    return both.$and.filter((clause) => '$or' in clause).length === 2;
});

t.assert('every filter contributes its own clause — none is lost to a merge', () => {
    const everything = buildFilter(parse({
        orderType: 'physical',
        paymentMethod: 'cash_on_delivery',
        paymentStatus: 'paid',
        fulfillmentStatus: 'processing',
        vendorId: '507f1f77bcf86cd799439011',
        customerId: '507f1f77bcf86cd799439012',
        disputed: 'true',
        completed: 'false',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        search: 'ORD-2026-000001',
    })) as { $and: unknown[] };
    return everything.$and.length === 10;
});

t.assert(
    'a term matching nothing returns nothing, not everything',
    () => JSON.stringify(buildFilter(parse({ search: '111111111111111111111111' }))).includes('$or'),
);
t.assert(
    'the date range is half-open [from, to)',
    () => JSON.stringify(buildFilter(parse({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }))).includes('$lt'),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. Nothing sensitive leaves');

t.assert('the module has files to scan', () => files.length >= 5);

for (const needle of [
    'delivery_address.coordinates',
    'delivery_address.raw_input',
    'delivery_address.provider_place_id',
    'address_snapshot',
]) {
    t.assert(`no file names ${needle}`, () => files.every((f) => !f.code.includes(needle)));
}

t.assert(
    'no projection uses the whole-subdocument form `delivery_address: 1`',
    () => files.every((f) => !/\bdelivery_address:\s*1/.test(f.code)),
);
t.assert(
    'no projection uses `items.delivery.pickup_location: 1`',
    () => files.every((f) => !/'items\.delivery\.pickup_location':\s*1/.test(f.code)),
);
t.assert(
    'the detail projects the address TEXTUALLY instead',
    () => repo.code.includes("'delivery_address.formatted_address': 1"),
);
t.assert(
    'payment_intent_id is in the DETAIL projection only',
    () => repo.code.indexOf('payment_intent_id: 1') > repo.code.indexOf('ORDER_DETAIL_PROJECTION'),
);
t.assert(
    'price_breakdown is in the DETAIL projection only',
    () => repo.code.indexOf('price_breakdown: 1') > repo.code.indexOf('ORDER_DETAIL_PROJECTION'),
);
t.assert(
    'the list projects only items._id — never the whole array',
    () => repo.code.includes("'items._id': 1"),
);

/**
 * MongoDB refuses a projection naming BOTH a path and a subpath of it —
 * `{ 'dispute_hold.active': 1, dispute_hold: 1 }` is `Path collision at dispute_hold`, a
 * runtime 500 rather than a widening. It is easy to reintroduce by spreading one projection
 * into another, which is exactly how it happened once; `verify:orders` caught it and this
 * keeps it caught without a database.
 */
t.assert('no projection names both a path and a subpath of it', () => {
    for (const { code } of files) {
        for (const block of code.match(/\{[^{}]*'[a-z_]+\.[a-z_.]+':\s*1[^{}]*\}/g) ?? []) {
            const keys = [...block.matchAll(/'?([a-z_][a-z_.]*)'?\s*:\s*1/g)].map((m) => m[1]);
            const whole = new Set(keys.filter((k) => !k.includes('.')));
            for (const key of keys) {
                if (key.includes('.') && whole.has(key.split('.')[0])) return false;
            }
        }
    }
    return true;
});

/**
 * ── The projection has to sit in the WRITE path too (DATA-EXPOSURE § 6) ───────
 * Both locks above guard the read. Until Phase 4 neither sat in the path of a delegated
 * write's response: `cancel`, `dispute/resolve` and the `order` half of `dispatch` answered
 * with jovi-mall's echoed Mongoose document, so the write handed back exactly the
 * `delivery_address.coordinates` / `.raw_input` / `address_snapshot` the read refuses.
 *
 * A projection scan cannot see that — the offending fields are never *named* in this
 * service, they arrive over HTTP — so these assert the shape of the handlers instead.
 */
const controllerCode = files.find((f) => f.file.endsWith('order.controller.ts'))!.code;

/** One handler's body, from `static <name> = asyncHandler(` to the closing `});`. */
function handlerBody(source: string, name: string): string | null {
    const at = source.indexOf(`static ${name} = asyncHandler(`);
    if (at === -1) return null;
    const rest = source.slice(at);
    const end = rest.indexOf('\n    });');
    return end === -1 ? rest : rest.slice(0, end);
}

/** The three delegated writes whose response carried the raw platform document. */
const DELEGATED_ORDER_WRITES = ['cancel', 'resolveDispute', 'dispatch'];

t.assert('all three delegated write handlers are found by the scan', () =>
    DELEGATED_ORDER_WRITES.every((name) => handlerBody(controllerCode, name) !== null));

t.assert('each delegated write re-reads through the projected detail before answering', () => {
    const offenders = DELEGATED_ORDER_WRITES.filter(
        (name) => !(handlerBody(controllerCode, name) ?? '').includes('readOrderDetail('),
    );
    if (offenders.length > 0) console.error(`      offenders: ${offenders.join(', ')}`);
    return offenders.length === 0;
});

/**
 * The sharper one. Reaching `readOrderDetail` is not enough — the defect returns the moment
 * the gateway's own reply is what reaches `sendSuccess`. So: whatever `await gateway.*`
 * was assigned to must not appear in the response payload at all. `dispatch` keeps
 * `result.shipmentsAssigned`, which is a number and is the one exemption.
 */
t.assert('no delegated write sends the gateway’s reply as its payload', () => {
    const offenders: string[] = [];

    for (const name of DELEGATED_ORDER_WRITES) {
        const body = handlerBody(controllerCode, name) ?? '';
        const assigned = /const\s+(\w+)\s*=\s*await\s+gateway\./.exec(body)?.[1];
        if (!assigned) continue;   // nothing was kept — cancel and resolveDispute

        const payload = body.slice(body.indexOf('sendSuccess(res,')).split(`${assigned}.shipmentsAssigned`).join('');
        if (new RegExp(`\\b${assigned}\\b`).test(payload)) offenders.push(`${name} (sends ${assigned})`);
    }

    if (offenders.length > 0) console.error(`      offenders: ${offenders.join(', ')}`);
    return offenders.length === 0;
});

t.assert('dispatch keeps its { shipmentsAssigned, order } shape — only the order half was the finding', () => {
    const body = handlerBody(controllerCode, 'dispatch') ?? '';
    return body.includes('shipmentsAssigned: result.shipmentsAssigned') && body.includes('order: after');
});

/**
 * One mapper, reached by one function, so the write and the read cannot disagree. A second
 * call site is how they drift apart again — which is the class of defect § 6 is, not just
 * the instance.
 */
t.assert('the controller maps the detail DTO in exactly one place', () =>
    (controllerCode.match(/toOrderDetailDto\(/g) ?? []).length === 1);

t.assert('the detail GET answers through that same function', () =>
    (handlerBody(controllerCode, 'detail') ?? '').includes('readOrderDetail('));

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The search uses the index it was designed for');

t.assert(
    'the order-number branch is ANCHORED',
    () => repo.code.includes("new RegExp('^' + escapeRegex(term.toUpperCase()))"),
);
t.assert(
    'containsInsensitive is never applied to the order filter',
    () => !repo.code.includes('containsInsensitive'),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Every sortable field is index-backed in jovi-mall');

const orderModel = readFileSync(join(JOVI, 'modules', 'orders', 'order.model.ts'), 'utf8');

t.assert('jovi-mall declares {created_at: -1}', () => orderModel.includes('OrderSchema.index({ created_at: -1 })'));
t.assert(
    'jovi-mall declares the payment-status compound',
    () => orderModel.includes('OrderSchema.index({ payment_status: 1, created_at: -1 })'),
);
t.assert(
    'jovi-mall declares the fulfillment-status compound',
    () => orderModel.includes('OrderSchema.index({ fulfillment_status: 1, created_at: -1 })'),
);
t.assert('jovi-mall declares the partial dispute-queue index', () => orderModel.includes("name: 'dispute_queue'"));
t.assert(
    'the superseded single-field payment_status index is gone from the schema',
    () => !/payment_status:\s*\{[^}]*index:\s*true/s.test(orderModel),
);
t.assert(
    'ORDER_SORT maps only createdAt — nothing unindexed is sortable',
    () => Object.keys(ORDER_SORT).length === 1 && ORDER_SORT.createdAt === 'created_at',
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The audit catalog wiring');

const ORDER_ACTIONS = ['orders.cancel', 'orders.dispatch', 'orders.refund', 'orders.disputes.resolve'];

for (const action of ORDER_ACTIONS) {
    t.assert(`${action} is in the catalog`, () => auditCatalog[action] !== undefined);
    t.assert(`${action} targets an order`, () => auditCatalog[action]?.target === 'order');
    t.assert(`${action} is delegated`, () => auditCatalog[action]?.transport === 'delegated');
    t.assert(
        `${action}'s permission is in the orders family`,
        () => (auditCatalog[action]?.permission ?? '').startsWith('orders.'),
    );
}

t.assert(
    'cancel and dispatch share one permission but keep separate action names',
    () => auditCatalog['orders.cancel'].permission === 'orders.intervene'
        && auditCatalog['orders.dispatch'].permission === 'orders.intervene',
);
t.assert(
    'the activity filter is DERIVED from the catalog, so it cannot drift',
    () => ORDER_AUDIT_ACTIONS.length === ORDER_ACTIONS.length,
);
t.assert(
    'the activity feed refuses an action from another family',
    () => throws(() => ListOrderActivityQuerySchema.parse({ action: 'vendors.suspend' })),
);
t.assert('...and accepts every order action', () => ORDER_AUDIT_ACTIONS.every((action) => {
    try {
        ListOrderActivityQuerySchema.parse({ action });
        return true;
    } catch {
        return false;
    }
}));

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Permissions — the two that move money are flagged');

t.assert('orders.refund is financial', () => permissions['orders.refund'].financial === true);
t.assert('orders.disputes.resolve is financial', () => permissions['orders.disputes.resolve'].financial === true);
t.assert(
    'orders.read is NOT financial — Support needs it to answer a ticket',
    () => permissions['orders.read'].financial !== true,
);
t.assert(
    'orders.intervene is NOT financial — cancel and dispatch move no money',
    () => permissions['orders.intervene'].financial !== true,
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. Routes are declared through defineRoute, with the right access');

const routes = routeManifest().filter((route) => route.fullPath.startsWith('/api/v1/orders'));

t.assert('ten order routes are registered', () => routes.length === 10);
t.assert('every one carries an access declaration', () => routes.every((route) => route.access !== undefined));
t.assert(
    'none is public',
    () => routes.every((route) => !JSON.stringify(route.access).includes('"public"')),
);
t.assert('the literal /disputes is declared BEFORE /:orderId', () => {
    const disputes = routes.findIndex((r) => r.fullPath === '/api/v1/orders/disputes');
    const detail = routes.findIndex((r) => r.fullPath === '/api/v1/orders/:orderId');
    return disputes >= 0 && detail >= 0 && disputes < detail;
});
t.assert(
    'refund-eligibility is gated on orders.refund, not orders.read — it answers a money ceiling',
    () => JSON.stringify(routes.find((r) => r.fullPath.endsWith('/refund-eligibility'))?.access)
        .includes('orders.refund'),
);
t.assert(
    'the activity feed additionally requires audit.read',
    () => JSON.stringify(routes.find((r) => r.fullPath.endsWith('/activity'))?.access).includes('audit.read'),
);
t.assert(
    'no route is registered directly on the router',
    () => readCode(join(MODULE, 'routes')).every((f) => !/router\.(get|post|patch|put|delete)\(/.test(f.code)),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('9. Write bodies are strict and reasoned');

t.assert('a cancel reason is required', () => throws(() => CancelOrderSchema.parse({})));
t.assert('a blank cancel reason is refused', () => throws(() => CancelOrderSchema.parse({ reason: '   ' })));
t.assert('an unknown key is refused', () => throws(() => CancelOrderSchema.parse({ reason: 'a reason', extra: 1 })));

t.assert('a refund reason is required', () => throws(() => RefundOrderSchema.parse({})));
t.assert(
    'a negative refund amount is refused',
    () => throws(() => RefundOrderSchema.parse({ amount: -5, reason: 'a reason' })),
);
t.assert(
    'a zero refund amount is refused',
    () => throws(() => RefundOrderSchema.parse({ amount: 0, reason: 'a reason' })),
);
t.assert(
    'an absent amount is allowed — it means the full remaining balance',
    () => RefundOrderSchema.parse({ reason: 'chargeback settled out of band' }).amount === undefined,
);
t.assert(
    'overridePolicy uses boolFlag — the string "false" stays false',
    () => RefundOrderSchema.parse({ reason: 'a reason', overridePolicy: 'false' }).overridePolicy === false,
);

t.assert('a dispute outcome is pinned', () => throws(() => ResolveDisputeSchema.parse({ outcome: 'maybe' })));
t.assert('won is accepted', () => ResolveDisputeSchema.parse({ outcome: 'won' }).outcome === 'won');

t.assert(
    'the timeline actor filter is pinned — this service writes `admin` rows',
    () => ListOrderTimelineQuerySchema.parse({ actorType: 'admin' }).actorType === 'admin',
);
t.assert(
    'an unknown timeline actor is refused',
    () => throws(() => ListOrderTimelineQuerySchema.parse({ actorType: 'robot' })),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('10. Data access — read direct, write delegated');

for (const name of ['orders', 'order_timelines', 'payment_transactions', 'refund_transactions']) {
    t.assert(`${name} is declared`, () => collections[name] !== undefined);
    t.assert(`${name} is read-only here`, () => collections[name]?.access === 'read');
    t.assert(`${name} writes go over the internal API`, () => collections[name]?.writes === 'internal-api');
}

t.assert(
    'no collection became owned — still exactly the two blog ones',
    () => Object.values(collections).filter((spec) => spec.access === 'owned').length === 2,
);
t.assert(
    'every gateway write goes through platformRequest',
    () => readCode(join(MODULE, 'gateways')).every((f) => f.code.includes('platformRequest')),
);
t.assert(
    'the audit wrapper lives in the gateway, not the controller',
    () => readCode(join(MODULE, 'gateways')).some((f) => f.code.includes('auditedAttempt')),
);
t.assert(
    'the controller never calls auditedAttempt directly',
    () => readCode(join(MODULE, 'controllers')).every((f) => !f.code.includes('auditedAttempt')),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('11. jovi-mall enforces what this surface delegates');

const orderService = readFileSync(join(JOVI, 'modules', 'orders', 'order.service.ts'), 'utf8');
const customerController = readFileSync(join(JOVI, 'modules', 'orders', 'customer-order.controller.ts'), 'utf8');
const orchestrator = readFileSync(
    join(JOVI, 'modules', 'payments', 'services', 'payment-orchestrator.service.ts'), 'utf8',
);
const adminRefund = readFileSync(join(JOVI, 'modules', 'orders', 'admin-refund.service.ts'), 'utf8');

t.assert(
    'the cancellation guards live on the SERVICE, shared by both callers',
    () => orderService.includes('async assertCancellable('),
);
t.assert(
    '...and the two constants moved with them',
    () => orderService.includes('export const CANCELLABLE_FULFILLMENT_STATES')
        && orderService.includes('export const COD_NON_CANCELLABLE_SHIPMENT_STATUSES'),
);
t.assert(
    'the customer path calls the shared guard rather than keeping a copy',
    () => customerController.includes('assertCancellable('),
);
t.assert(
    'the customer controller no longer declares its own cancellable states',
    () => !customerController.includes('const CANCELLABLE_FULFILLMENT_STATES'),
);

// F-4 — the cart-group refund defect, in both halves.
t.assert(
    'the refund lookup covers cart-group payments (orderIds), not just orderId',
    () => orchestrator.includes('{ orderIds: new Types.ObjectId(sourceId) }'),
);
t.assert(
    'a per-source ceiling exists — a group payment cannot fund one order’s refund from another’s',
    () => orchestrator.includes('refundableCeilingFor'),
);
t.assert(
    'the source and the payment have SEPARATE fully-refunded verdicts',
    () => orchestrator.includes('sourceFullyRefunded') && orchestrator.includes('paymentFullyRefunded'),
);

t.assert(
    'the admin refund reuses the vendor policy calculator rather than copying it',
    () => adminRefund.includes('computeVendorRefundEligibility'),
);
t.assert(
    'it enters the orchestrator, so the money invariants are not reimplemented',
    () => adminRefund.includes('refundPayment(') && adminRefund.includes("initiatedByRole: 'admin'"),
);
t.assert('COD is refused with its own code', () => adminRefund.includes('REFUND_ORDER_IS_COD'));
t.assert(
    'the policy override is required rather than assumed',
    () => adminRefund.includes('REFUND_POLICY_OVERRIDE_REQUIRED'),
);

// F-5 — a manual dispute resolution that changed nothing must say so.
const disputeService = readFileSync(join(JOVI, 'modules', 'payments', 'services', 'dispute.service.ts'), 'utf8');
t.assert(
    'adminResolveOrder reports whether it actually resolved anything',
    () => disputeService.includes("Promise<DisputeResolution>") && disputeService.includes("'noop'"),
);
t.assert(
    'it takes an actor, so the timeline row is not anonymous',
    () => disputeService.includes('actor: DisputeActor = SYSTEM_ACTOR'),
);

process.exit(t.finish());

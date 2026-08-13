/**
 * Verify: orders and shipments, end to end, against REAL infrastructure.
 *
 * `test:orders` and `test:shipments` prove the rules are internally consistent — the
 * schemas, the filters, the projections as CONSTANTS. They structurally cannot prove the
 * one thing that matters most here:
 *
 *   Gate A  **the COD delivery code does not leave the database.** jovi-mall marks
 *           `code_plain` `select: false`; this service reads with the raw MongoDB driver,
 *           which does not honour that. The projection whitelist is the only guard, and a
 *           source scan proves what a constant says, not what an HTTP response contains.
 *           So this plants a poison code on a real collection and greps every response.
 *   Gate B  a delivery agent's GPS position does not leave either — `handover.pickup.geo`
 *           and `.location` are the platform's most closely held datum.
 *   Gate C  a customer's home coordinates do not leave on the order surface.
 *   Gate D  the lists actually run, page correctly, and their `$and` filters compose
 *           against a real Mongo rather than in a unit test's imagination.
 *   Gate E  the permission split is real: a Support administrator can read an order and
 *           CANNOT see a refund ceiling.
 *
 * Gates A–C are the reason this file exists. Everything else is covered DB-free.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo (wi-admin as a replica set, for the audit transactions) + Redis
 *   jovi-mall is NOT required — every gate here is a READ. The delegated writes are
 *   covered by `test:orders` §11, which scans jovi-mall's source for the guards.
 *
 * It creates its own throwaway orders, shipments, cash collection and administrators, and
 * deletes every one at the end, pass or fail. It never touches a pre-existing row.
 *
 * Run: npm run verify:orders
 */
import 'dotenv/config';

process.env.ADMIN_AUTH_RATE_LIMIT_MAX = '500';

import type { Server } from 'http';
import { ObjectId } from 'mongodb';
import { suite } from './_assert';
import { env } from '../../src/config/env';
import { createApp } from '../../src/app';
import { connectAll, closeAll, platformConnection, adminConnection } from '../../src/infra/mongo/connections';
import { closeRedisClients, getRedisClient, ADMIN_SESSION_DB } from '../../src/infra/redis/redis.factory';
import { AdminAccountModel } from '../../src/modules/admin-identity/models/admin-account.model';
import { AdminSessionModel } from '../../src/modules/admin-identity/models/admin-session.model';
import { AdminAccountRepository } from '../../src/modules/admin-identity/repositories/admin-account.repository';
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model';
import { COLLECTIONS } from '../../src/infra/platform/collections';

const t = suite('wi-admin orders & shipments — live');

const PASSWORD = 'verify-orders-suite-password-7712';
const EMAIL_ADMIN = 'verify-orders-admin@example.test';
const EMAIL_SUPPORT = 'verify-orders-support@example.test';

const FIXTURE_TAG = 'verify-orders-fixture';

/**
 * The poison strings. Each is planted on a real document in a field the projections must
 * exclude, and Gate A/B/C grep every response body for them.
 *
 * This is the difference between "the constant does not name it" and "it did not come
 * out" — the same technique the users and vendors suites use, applied to the two most
 * dangerous values on the platform.
 */
const POISON_CODE = 'COD-CODE-MUST-NEVER-LEAVE';
const POISON_CODE_HASH = 'COD-HASH-MUST-NEVER-LEAVE';
const POISON_RAW_ADDRESS = 'RAW-ADDRESS-MUST-NEVER-LEAVE';

/** A GPS position, planted where a previous agent's would sit. */
const POISON_LNG = -13.579135;
const POISON_LAT = 42.246813;

interface Res { status: number; body: any; cookies: Record<string, string> }

let port = 0;

function parseCookies(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    return out;
}

async function call(
    method: string,
    path: string,
    options: { body?: unknown; cookies?: Record<string, string>; csrf?: string } = {},
): Promise<Res> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.cookies && Object.keys(options.cookies).length > 0) {
        headers.Cookie = Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (options.csrf) headers['X-CSRF-Token'] = options.csrf;

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await response.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, cookies: parseCookies(response.headers) };
}

interface Session { adminId: string; cookies: Record<string, string>; csrf: string }

async function signIn(email: string): Promise<Session> {
    const res = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    if (res.status !== 200 || res.body?.data?.mfaEnrolmentRequired) {
        throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const me = await call('GET', '/api/v1/auth/me', { cookies: res.cookies });
    return { adminId: me.body?.data?.admin?.id, cookies: res.cookies, csrf: res.cookies.admin_csrf_token ?? '' };
}

const get = (s: Session, path: string) => call('GET', path, { cookies: s.cookies });

function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

const FIXTURE_COLLECTIONS = [
    COLLECTIONS.ORDER,
    COLLECTIONS.ORDER_TIMELINE,
    COLLECTIONS.SHIPMENT,
    COLLECTIONS.CASH_COLLECTION,
    COLLECTIONS.SHIPMENT_ASSIGNMENT_OFFER,
    COLLECTIONS.CUSTOMER,
    COLLECTIONS.VENDOR,
    COLLECTIONS.DELIVERY_AGENCY,
    COLLECTIONS.DELIVERY_AGENT,
] as const;

async function cleanupPlatform(): Promise<void> {
    for (const collection of FIXTURE_COLLECTIONS) {
        await platformDb().collection(collection).deleteMany({ [FIXTURE_TAG]: true });
    }
}

async function cleanupAdmin(): Promise<void> {
    const admins = await AdminAccountModel().find(
        { email: { $in: [EMAIL_ADMIN, EMAIL_SUPPORT] } }, { _id: 1 },
    );
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
        await AdminSessionModel().deleteMany({ admin_id: { $in: ids } });
        await AdminAccountModel().deleteMany({ _id: { $in: ids } });
        await AuditLogModel().deleteMany({ actor_id: { $in: ids } });
    }
    const redis = await getRedisClient(ADMIN_SESSION_DB);
    for (const id of ids) {
        const sids = await redis.sMembers(`admin-sessions:${id.toString()}`);
        for (const sid of sids) await redis.del(`session:${sid}`);
        await redis.del(`admin-sessions:${id.toString()}`);
    }
}

/** Every poison string, checked against one response body at once. */
function leaks(res: Res): string[] {
    const text = JSON.stringify(res.body ?? '');
    const found: string[] = [];
    if (text.includes(POISON_CODE)) found.push('code_plain');
    if (text.includes(POISON_CODE_HASH)) found.push('code_hash');
    if (text.includes(POISON_RAW_ADDRESS)) found.push('delivery_address.raw_input');
    if (text.includes(String(POISON_LNG)) || text.includes(String(POISON_LAT))) found.push('gps coordinates');
    return found;
}

async function main(): Promise<number> {
    let server: Server | null = null;

    try {
        env();
        await connectAll();
        await cleanupAdmin();
        await cleanupPlatform();

        const accounts = new AdminAccountRepository();
        const passwordHash = await hash(PASSWORD);

        const make = async (email: string, displayName: string, tier: AdminTier) => {
            const session = await adminConnection().startSession();
            try {
                await session.withTransaction(async () => {
                    await accounts.create({ email, displayName, passwordHash, tier }, session);
                });
            } finally {
                await session.endSession();
            }
        };
        await make(EMAIL_ADMIN, 'Verify Orders Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Orders Support', 3);

        // ── Fixtures, planted directly so no jovi-mall process is needed ──────
        const vendorId = new ObjectId();
        const customerId = new ObjectId();
        const agencyId = new ObjectId();
        const agentId = new ObjectId();
        const orderId = new ObjectId();
        const shipmentId = new ObjectId();
        const now = new Date();

        await platformDb().collection(COLLECTIONS.VENDOR).insertOne({
            _id: vendorId, [FIXTURE_TAG]: true, display_name: 'Verify Orders Vendor',
            status: 'active', created_at: now, updated_at: now,
        } as never);
        await platformDb().collection(COLLECTIONS.CUSTOMER).insertOne({
            _id: customerId, [FIXTURE_TAG]: true, name: 'Verify Orders Customer',
            created_at: now, updated_at: now,
        } as never);
        await platformDb().collection(COLLECTIONS.DELIVERY_AGENCY).insertOne({
            _id: agencyId, [FIXTURE_TAG]: true, display_name: 'Verify Orders Agency',
            status: 'active', created_at: now, updated_at: now,
        } as never);
        await platformDb().collection(COLLECTIONS.DELIVERY_AGENT).insertOne({
            _id: agentId, [FIXTURE_TAG]: true, display_name: 'Verify Orders Agent',
            status: 'active', created_at: now, updated_at: now,
        } as never);

        const ORDER_NUMBER = 'ORD-2999-VERIFY';
        await platformDb().collection(COLLECTIONS.ORDER).insertOne({
            _id: orderId, [FIXTURE_TAG]: true,
            order_number: ORDER_NUMBER,
            order_type: 'physical',
            cart_id: new ObjectId(),
            vendor_id: vendorId,
            customer_id: customerId,
            currency: 'XAF',
            total_amount: 45000,
            price_breakdown: { base: 45000, tax: 0, discount: 0, total: 45000 },
            payment_method: 'cash_on_delivery',
            payment_status: 'AWAITING_PAYMENT',
            payment_intent_id: 'pi_verify_orders',
            fulfillment_status: 'processing',
            // Gate C: the coordinates and the raw input must not come out.
            delivery_address: {
                formatted_address: '12 Verify Street, Douala',
                coordinates: { type: 'Point', coordinates: [POISON_LNG, POISON_LAT] },
                raw_input: POISON_RAW_ADDRESS,
                components: { city: 'Douala', country: 'CM' },
            },
            items: [{
                _id: new ObjectId(), product_id: new ObjectId(), variant_id: new ObjectId(),
                title: 'Verify item', quantity: 1, price: 45000, currency: 'XAF',
                product_type: 'physical', vendor_id: vendorId,
                delivery: {
                    agency_id: agencyId, shipment_id: shipmentId, status: 'assigned',
                    pickup_location: {
                        source: 'vendor_address',
                        vendor_address_id: new ObjectId(),
                        // Gate C again, one party over: a vendor's premises.
                        address_snapshot: { geo: { raw_input: POISON_RAW_ADDRESS } },
                    },
                },
            }],
            created_at: now, updated_at: now,
        } as never);

        await platformDb().collection(COLLECTIONS.SHIPMENT).insertOne({
            _id: shipmentId, [FIXTURE_TAG]: true,
            order_id: orderId, agency_id: agencyId, agent_id: agentId,
            status: 'assigned',
            tracking_number: 'VER-991231-235959-ZZZZZ',
            assignment: { state: 'accepted', current_offer_id: null, offered_agent_id: agentId, updated_at: now },
            status_history: [{ status: 'assigned', changed_at: now, changed_by_user_id: null, changed_by_role: 'system' }],
            // Gate B: a previous agent's GPS, in both shapes it can take.
            handover: {
                from_agent_id: new ObjectId(), from_status: 'in_transit', reassigned_at: now,
                pickup: {
                    source: 'previous_agent_location',
                    label: 'Where the last agent stopped',
                    location: { type: 'Point', coordinates: [POISON_LNG, POISON_LAT] },
                    geo: { coordinates: [POISON_LNG, POISON_LAT], raw_input: POISON_RAW_ADDRESS },
                    address: { city: 'Douala' },
                },
            },
            items: [{ order_item_id: new ObjectId(), product_id: new ObjectId(), quantity: 1 }],
            created_at: now, updated_at: now,
        } as never);

        // Gate A: the COD delivery code, on a real cash_collections row.
        await platformDb().collection(COLLECTIONS.CASH_COLLECTION).insertOne({
            _id: new ObjectId(), [FIXTURE_TAG]: true,
            order_id: orderId, shipment_id: shipmentId, agency_id: agencyId, agent_id: agentId,
            status: 'pending',
            expected_amount: 45000, currency: 'XAF',
            code_plain: POISON_CODE,
            code_hash: POISON_CODE_HASH,
            code_attempts: 0, code_locked: false, code_generated_at: now,
            verification: {
                method: 'code',
                location: { type: 'Point', coordinates: [POISON_LNG, POISON_LAT] },
                ip: '10.0.0.1',
                device_info: 'verify-suite',
            },
        } as never);

        const app = createApp();
        await new Promise<void>((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                port = (server!.address() as { port: number }).port;
                resolve();
            });
        });

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        // ─────────────────────────────────────────────────────────────────────
        t.section('Gate D — the lists run against a real Mongo');

        const list = await get(admin, '/api/v1/orders?limit=5');
        t.assert('the order list answers 200', () => list.status === 200);
        t.assert('...with a page envelope', () => typeof list.body?.meta?.pages === 'number');

        const found = await get(admin, `/api/v1/orders?search=${ORDER_NUMBER}`);
        t.assert('the anchored order-number search finds the fixture', () => found.status === 200
            && found.body.data.some((o: { orderNumber: string }) => o.orderNumber === ORDER_NUMBER));

        const filtered = await get(admin, '/api/v1/orders?paymentMethod=cash_on_delivery&fulfillmentStatus=processing&completed=false');
        t.assert('a three-clause $and filter runs', () => filtered.status === 200);

        const shipmentList = await get(admin, '/api/v1/shipments?status=assigned');
        t.assert('the shipment list answers 200', () => shipmentList.status === 200);

        const shipmentSearch = await get(admin, '/api/v1/shipments?search=VER-991231');
        t.assert('the anchored tracking-number search finds the fixture', () => shipmentSearch.status === 200
            && shipmentSearch.body.data.some((s: { id: string }) => s.id === shipmentId.toString()));

        const timeline = await get(admin, `/api/v1/orders/${orderId}/timeline`);
        t.assert('the order timeline answers 200', () => timeline.status === 200);

        // ─────────────────────────────────────────────────────────────────────
        t.section('Gate A/B/C — NOTHING SENSITIVE LEAVES, from a real response body');

        const orderDetail = await get(admin, `/api/v1/orders/${orderId}`);
        t.assert('the order detail answers 200', () => orderDetail.status === 200);
        t.assert(
            'the order detail leaks nothing',
            () => leaks(orderDetail).length === 0,
        );
        t.assert(
            '...and still carries the TEXTUAL address, so it is useful',
            () => orderDetail.body?.data?.deliveryAddress?.formattedAddress === '12 Verify Street, Douala',
        );
        t.assert('...and the amount, which Support needs', () => orderDetail.body?.data?.totalAmount === 45000);

        const shipmentDetail = await get(admin, `/api/v1/shipments/${shipmentId}`);
        t.assert('the shipment detail answers 200', () => shipmentDetail.status === 200);
        t.assert(
            'THE COD DELIVERY CODE DID NOT COME OUT',
            () => !JSON.stringify(shipmentDetail.body).includes(POISON_CODE),
        );
        t.assert(
            'nor its hash',
            () => !JSON.stringify(shipmentDetail.body).includes(POISON_CODE_HASH),
        );
        t.assert(
            'NOR THE AGENT’S GPS POSITION',
            () => !JSON.stringify(shipmentDetail.body).includes(String(POISON_LNG))
                && !JSON.stringify(shipmentDetail.body).includes(String(POISON_LAT)),
        );
        t.assert('the shipment detail leaks nothing at all', () => leaks(shipmentDetail).length === 0);
        t.assert(
            '...and still reports the cash position, so it is useful',
            () => shipmentDetail.body?.data?.cod?.expectedAmount === 45000
                && shipmentDetail.body?.data?.cod?.status === 'pending',
        );
        t.assert(
            '...and the handover source, without the point',
            () => shipmentDetail.body?.data?.handover?.source === 'previous_agent_location',
        );
        t.assert(
            '...and reports outbox health rather than a trackability verdict',
            () => typeof shipmentDetail.body?.data?.tracking?.outbox?.pending === 'number',
        );

        t.assert('the LIST leaks nothing either', () => leaks(shipmentList).length === 0);
        t.assert('nor the order list', () => leaks(list).length === 0);

        // ─────────────────────────────────────────────────────────────────────
        t.section('Gate E — the permission split is real');

        const supportRead = await get(support, `/api/v1/orders/${orderId}`);
        t.assert('Support CAN read an order', () => supportRead.status === 200);

        const supportShipment = await get(support, `/api/v1/shipments/${shipmentId}`);
        t.assert('Support CAN read a shipment', () => supportShipment.status === 200);

        const supportCeiling = await get(support, `/api/v1/orders/${orderId}/refund-eligibility`);
        t.assert(
            'Support CANNOT see a refund ceiling — it is a money answer, not a record',
            () => supportCeiling.status === 403,
        );

        const supportDisputes = await get(support, '/api/v1/orders/disputes');
        t.assert('Support CAN read the dispute queue', () => supportDisputes.status === 200);

        // ─────────────────────────────────────────────────────────────────────
        t.section('Route order — /disputes is not read as an order id');

        t.assert(
            'GET /orders/disputes returns a page, not "Order not found"',
            () => supportDisputes.status === 200 && Array.isArray(supportDisputes.body?.data),
        );

        const missing = await get(admin, `/api/v1/orders/${new ObjectId()}`);
        t.assert('an unknown order is a 404', () => missing.status === 404);

        const badId = await get(admin, '/api/v1/orders/not-an-id');
        t.assert('a malformed id is a 400 from validation', () => badId.status === 400);

        return t.finish();
    } finally {
        await cleanupPlatform();
        await cleanupAdmin();
        if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
        await closeRedisClients();
        await closeAll();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('\n  ✖ verify:orders crashed:', error);
        process.exit(1);
    });

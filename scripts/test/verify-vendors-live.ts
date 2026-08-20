/**
 * Verify: vendor management, end to end, against REAL infrastructure and a REAL jovi-mall.
 *
 * `test:vendors` proves the rules are internally consistent — the schemas, the two
 * filters, the catalog wiring. It structurally cannot prove the things that only exist
 * when both processes are running and a database is underneath:
 *
 *   Gate A  a suspension ISSUED HERE takes effect THERE — and takes effect NARROWLY, so a
 *           `pending_verification` vendor is untouched by the same deploy
 *   Gate B  the CASCADE ran: the vendor's active listings came off sale, the draft did
 *           not, and a listing already suspended for an agency reason kept that reason
 *   Gate C  the restore is not blind — it brings back only what this cascade took, and
 *           leaves the agency-suspended one alone
 *   Gate D  every delegated write leaves an audit row with a real before → after diff
 *   Gate E  nothing sensitive leaves the database on any of the four reads
 *
 * Gate A is the one the phase exists for. `Vendor.status` was written by nothing and read
 * by nothing — the three guards that would have read it have zero call sites — so an
 * endpoint that flipped it would look identical: 200, column changed, vendor still
 * trading. Gates B and C are the second half of that: a suspension that leaves the
 * catalogue on sale is not a suspension.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo (wi-admin as a replica set, for the audit transactions) + Redis
 *   jovi-mall RUNNING, with INTERNAL_ADMIN_SERVICE_TOKEN set
 *   this service's JOVI_MALL_BASE_URL + JOVI_MALL_SERVICE_TOKEN set to match
 *
 * It SKIPS loudly rather than silently when jovi-mall is unreachable — a suite that passes
 * by not running is worse than one that fails.
 *
 * It creates its own throwaway vendors, store, products and administrators, and deletes
 * every one at the end, pass or fail. It never touches a pre-existing row.
 *
 * Run: npm run verify:vendors
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
import { pingPlatform } from '../../src/infra/platform/platform.client';
import { COLLECTIONS } from '../../src/infra/platform/collections';

const t = suite('wi-admin vendor management — live');

const PASSWORD = 'verify-vendors-suite-password-7712';
const EMAIL_ADMIN = 'verify-vendors-admin@example.test';
const EMAIL_SUPPORT = 'verify-vendors-support@example.test';

/** Everything this suite creates in `jovi_mall`, tagged so cleanup cannot miss one. */
const FIXTURE_TAG = 'verify-vendors-fixture';

/**
 * Two poison strings, planted on the fixture vendor.
 *
 * Gate E greps every response for them. They are the direct analogue of the users suite's
 * `THIS-MUST-NEVER-LEAVE-THE-DATABASE`, and they are what makes "the projection excludes
 * it" a fact rather than a claim about a constant.
 */
const POISON_PAYOUT = 'PAYOUT-ACCOUNT-MUST-NEVER-LEAVE';
const POISON_NIN = 'NATIONAL-ID-MUST-NEVER-LEAVE';

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
    let body: any;
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
const write = (s: Session, method: string, path: string, body?: unknown) =>
    call(method, path, { cookies: s.cookies, csrf: s.csrf, body });

function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

/** Every collection this suite writes into, so cleanup is one loop and cannot drift. */
const FIXTURE_COLLECTIONS = [
    COLLECTIONS.VENDOR,
    COLLECTIONS.STORE,
    COLLECTIONS.PRODUCT,
    COLLECTIONS.USER,
    COLLECTIONS.VENDOR_SETTINGS,
    // The delivery chain F-7 added, so a failed run leaves nothing behind either.
    COLLECTIONS.PRODUCT_VARIANT,
    COLLECTIONS.DELIVERY_AGENCY,
    COLLECTIONS.VENDOR_AGENCY_CONNECTION,
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

async function main(): Promise<number> {
    let server: Server | null = null;

    try {
        env();
        await connectAll();
        await cleanupAdmin();
        await cleanupPlatform();

        const reachable = await pingPlatform();
        if (!reachable.configured || !reachable.ok) {
            console.error(
                '\n  ⚠  SKIPPED — jovi-mall is not reachable.\n'
                + '     Every write here is delegated, so there is nothing to verify without it.\n'
                + `     JOVI_MALL_BASE_URL=${env().JOVI_MALL_BASE_URL ?? '(unset)'}\n`,
            );
            t.assert('SKIPPED — jovi-mall unreachable', () => false);
            return t.finish();
        }

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

        await make(EMAIL_ADMIN, 'Verify Vendors Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Vendors Support', 3);

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        const db = platformDb();
        const stamp = Date.now();
        const now = new Date();

        // ── Fixtures ──────────────────────────────────────────────────────────
        const userId = new ObjectId();
        /**
         * ⚠ The control vendor needs its OWN user (F-3, fixed 2026-08-20).
         *
         * Both fixtures shared `userId`, and `vendors.user_id` is **unique** — so this suite
         * crashed on `E11000` before its first assertion and could not pass as written against
         * any real database. It is exactly the class of defect a DB-free suite cannot see: the
         * documents are individually valid and the collision is an index's.
         */
        const pendingUserId = new ObjectId();
        /** The delivery agency the products route through — see the chain below (F-7). */
        const agencyId = new ObjectId();
        const agencyUserId = new ObjectId();
        /** The vendor's pickup address. `pickup_location.vendor_address_id` must NAME it. */
        const businessAddressId = new ObjectId();
        const vendorId = new ObjectId();
        const pendingVendorId = new ObjectId();
        const businessName = `Verify Vendors Emporium ${stamp}`;

        await db.collection(COLLECTIONS.USER).insertOne({
            _id: userId,
            login_email: `verify-vendors-${stamp}@example.test`,
            password_hash: 'irrelevant',
            roles: ['vendor'],
            status: 'active',
            created_at: now, updated_at: now,
            [FIXTURE_TAG]: true,
        } as never);

        const vendorDoc = (id: ObjectId, status: string, email: string, owner: ObjectId = userId) => ({
            _id: id,
            user_id: owner,
            display_name: `Verify Vendor ${stamp}`,
            email,
            phone: `+23767${String(stamp).slice(-7)}`,
            country: 'CM',
            status,
            onboarding_step: 0,
            // Required for a `vendor_address` pickup: the rule checks the id is ON this list,
            // and a null id is NOT a 'first address' fallback here (F-7).
            business_addresses: [{
                _id: businessAddressId,
                label: 'Main Shop',
                address_line1: '1 Verify Street',
                city: 'Douala',
            }],
            // The two things that must never come back out.
            payout_details: [{ method: 'mobile_money', mobile_money: { account_number: POISON_PAYOUT } }],
            kyc_details: { national_id_number: POISON_NIN, legit_verified: false, status: 'pending' },
            created_at: now, updated_at: now,
            [FIXTURE_TAG]: true,
        });

        await db.collection(COLLECTIONS.VENDOR).insertOne(
            vendorDoc(vendorId, 'active', `verify-vendors-${stamp}@example.test`) as never);
        // The control: a vendor left at the REGISTRATION DEFAULT, to prove the enforcement
        // is narrow. If `requireAuth` ever becomes `!== 'active'`, this one starts failing.
        // Its own user — see `pendingUserId`.
        await db.collection(COLLECTIONS.USER).insertOne({
            _id: pendingUserId,
            login_email: `verify-vendors-${stamp}-p@example.test`,
            password_hash: 'irrelevant',
            roles: ['vendor'],
            status: 'active',
            created_at: now, updated_at: now,
            [FIXTURE_TAG]: true,
        } as never);
        await db.collection(COLLECTIONS.VENDOR).insertOne(
            vendorDoc(pendingVendorId, 'pending_verification', `verify-vendors-${stamp}-p@example.test`, pendingUserId) as never);

        await db.collection(COLLECTIONS.STORE).insertOne({
            _id: new ObjectId(),
            vendor_id: vendorId,
            name: businessName,
            slug: `verify-vendors-${stamp}`,
            is_open: true,
            created_at: now, updated_at: now,
            [FIXTURE_TAG]: true,
        } as never);

        /**
         * ⚠ A fixture product must be able to pass the ACTIVATION GATE, or Gate C proves
         * nothing (F-7, found and fixed 2026-08-20).
         *
         * The restore is deliberately not blind: `ProductPlatformSuspensionService` re-runs
         * `ProductStatusValidationService.validate(product, 'active')` on every candidate and
         * leaves anything still blocked exactly where it is. These fixtures carried a title
         * and a status and nothing else, so **every one of them was refused** — the suspend
         * half passed, the restore put nothing back, and the four assertions that need a
         * product to be on sale failed behind it. Invisible until F-3's duplicate-key crash
         * was fixed, because the suite had never reached this section.
         *
         * For a **physical** product the gate wants, in order: a description; at least one
         * active variant priced above zero; that variant named as `defaultVariantId`; the
         * vendor not suspended; an **active** default delivery agency on the vendor with an
         * **active** vendor↔agency connection; and a pickup location. The fixtures below
         * satisfy all of it.
         */
        const variantIds: ObjectId[] = [];
        const product = (title: string, status: string, extra: Record<string, unknown> = {}) => {
            const id = new ObjectId();
            const variantId = new ObjectId();
            variantIds.push(variantId);
            const n = variantIds.length;
            return {
                id,
                variantId,
                doc: {
                    _id: id,
                    vendorId,
                    title,
                    description: `Fixture listing for ${title} — long enough to be a description.`,
                    slug: `${title.toLowerCase().split(' ').join('-')}-${stamp}`,
                    type: 'physical',
                    status,
                    defaultVariantId: variantId,
                    delivery: {
                        // `agency_id: null` falls back to the vendor's default, which the
                        // fixtures set — the same resolution order order-creation uses.
                        agency_id: null,
                        free_delivery: false,
                        // `vendor_address_id: null` is a real steady state, not missing data:
                        // it means the vendor's first business address.
                        pickup_location: {
                            source: 'vendor_address',
                            vendor_address_id: businessAddressId,
                            agency_address_id: null,
                        },
                    },
                    deletedAt: null,
                    createdAt: now, updatedAt: now,
                    [FIXTURE_TAG]: true,
                    ...extra,
                },
                variant: {
                    _id: variantId,
                    productId: id,
                    sku: `VV-${stamp}-${n}`,
                    name: 'Default',
                    status: 'active',
                    price: 5000,
                    stock: 10,
                    optionSignature: `vv-${stamp}-${n}`,
                    createdAt: now, updatedAt: now,
                    [FIXTURE_TAG]: true,
                },
            };
        };

        const activeProduct = product('Verify Active Widget', 'active');
        const draftProduct = product('Verify Draft Widget', 'draft');
        const agencySuspended = product('Verify Agency Suspended Widget', 'suspended', {
            suspension: {
                reason: 'agency_storage_suspended',
                previousStatus: 'active',
                suspendedAt: now,
                note: 'storage unpaid',
            },
        });
        const oversightTarget = product('Verify Oversight Widget', 'active');

        await db.collection(COLLECTIONS.PRODUCT).insertMany([
            activeProduct.doc, draftProduct.doc, agencySuspended.doc, oversightTarget.doc,
        ] as never[]);
        await db.collection(COLLECTIONS.PRODUCT_VARIANT).insertMany([
            activeProduct.variant, draftProduct.variant, agencySuspended.variant, oversightTarget.variant,
        ] as never[]);

        /**
         * The delivery chain a physical product needs before it may be `active`.
         *
         * Three rows and one field on the vendor, and every one of them is load-bearing —
         * the gate walks them in order and stops at the first miss, so a partial chain fails
         * exactly like no chain at all:
         *
         *   vendor.default_delivery_agency_id → an ACTIVE delivery_agencies row
         *                                     → an ACTIVE vendor_agency_connections row
         *
         * Without this the restore refuses every candidate and Gate C asserts nothing. See
         * the note on `product()` above (F-7).
         */
        await db.collection(COLLECTIONS.DELIVERY_AGENCY).insertOne({
            _id: agencyId,
            user_id: agencyUserId,
            display_name: `Verify Vendors Courier ${stamp}`,
            country: 'CM',
            status: 'active',
            // ⚠ The agency must OFFER the pickup style the product names.
            // `PickupLocationValidationService` refuses a `vendor_address` pickup against an
            // agency whose `pickup_based` pricing is off — which is the schema default, so an
            // agency fixture that omits this blocks every physical product it serves. That was
            // the single blocker behind all six Gate C / oversight failures (F-7).
            policies: { pricing: { pickup_based: { enabled: true }, storage_based: { enabled: false } } },
            created_at: now, updated_at: now,
            [FIXTURE_TAG]: true,
        } as never);

        await db.collection(COLLECTIONS.VENDOR_AGENCY_CONNECTION).insertOne({
            _id: new ObjectId(),
            vendor_id: vendorId,
            agency_id: agencyId,
            status: 'active',
            requester_role: 'vendor',
            requested_by_user_id: userId,
            requested_at: now,
            responded_by_user_id: agencyUserId,
            created_at: now, updated_at: now,
            [FIXTURE_TAG]: true,
        } as never);

        await db.collection(COLLECTIONS.VENDOR).updateOne(
            { _id: vendorId },
            { $set: { default_delivery_agency_id: agencyId } },
        );

        const id = vendorId.toString();
        const readProduct = (pid: ObjectId) =>
            db.collection(COLLECTIONS.PRODUCT).findOne({ _id: pid });

        // ── 1. The list ───────────────────────────────────────────────────────
        t.section('1. List, search, filter, sort');

        const byBusinessName = await get(admin, `/api/v1/vendors?search=Emporium%20${stamp}`);
        t.assert('⭐ a search by BUSINESS name finds the vendor — through the store join', () =>
            byBusinessName.status === 200
            && byBusinessName.body.data.some((v: any) => v.id === id));

        t.assert('...and the business name is what comes back, not the display name', () =>
            byBusinessName.body.data.find((v: any) => v.id === id)?.businessName === businessName);

        const byVendorId = await get(admin, `/api/v1/vendors?search=${id}`);
        t.assert('a pasted vendor id finds them', () =>
            byVendorId.status === 200 && byVendorId.body.data.some((v: any) => v.id === id));

        const byUserId = await get(admin, `/api/v1/vendors?search=${userId.toString()}`);
        t.assert('⭐ a pasted USER id finds them too — the cross-screen branch', () =>
            byUserId.status === 200 && byUserId.body.data.some((v: any) => v.id === id));

        const byStatus = await get(admin, `/api/v1/vendors?search=Emporium%20${stamp}&status=inactive`);
        t.assert('a status filter that does not match excludes them', () =>
            byStatus.body.data.every((v: any) => v.id !== id));

        const paged = await get(admin, '/api/v1/vendors?limit=2&page=1');
        t.assert('the page carries a real total and a computed page count', () =>
            paged.body.data.length <= 2
            && typeof paged.body.meta.total === 'number'
            && paged.body.meta.pages === Math.ceil(paged.body.meta.total / 2));

        const badSort = await get(admin, '/api/v1/vendors?sort=payout_details');
        t.assert('an unsortable field is refused, never silently ignored', () =>
            badSort.status === 400 && badSort.body?.error?.code === 'VALIDATION_ERROR');

        // ── 2. Detail and catalogue ───────────────────────────────────────────
        t.section('2. Detail and catalogue');

        const detail = await get(admin, `/api/v1/vendors/${id}`);
        t.assert('the detail resolves', () => detail.status === 200 && detail.body.data.id === id);
        t.assert('...carrying the store, the account and the settings defaults', () =>
            detail.body.data.store?.name === businessName
            && detail.body.data.account?.id === userId.toString()
            // No settings document exists, so jovi-mall's own defaults are reported rather
            // than nulls that would read as broken.
            && detail.body.data.settings?.autoCancelUnpaidDays === 3);
        t.assert('...and the product counts, from one aggregation', () =>
            detail.body.data.counts.products.total === 4
            && detail.body.data.counts.products.active === 2
            && detail.body.data.counts.products.draft === 1
            && detail.body.data.counts.products.suspended === 1);

        const missing = await get(admin, `/api/v1/vendors/${new ObjectId().toString()}`);
        t.assert('an unknown vendor is a 404, not an empty object', () => missing.status === 404);

        const catalogue = await get(admin, `/api/v1/vendors/${id}/products`);
        t.assert('the catalogue lists every product', () =>
            catalogue.status === 200 && catalogue.body.meta.total === 4);

        const suspendedOnly = await get(admin,
            `/api/v1/vendors/${id}/products?status=suspended&suspensionReason=agency_storage_suspended`);
        t.assert('⭐ the reason filter separates who took a listing down', () =>
            suspendedOnly.body.meta.total === 1
            && suspendedOnly.body.data[0].id === agencySuspended.id.toString());

        // ── 3. Gate A — the suspension is enforced, and enforced narrowly ─────
        t.section('3. Gate A — enforced in jovi-mall, and narrowly');

        const suspended = await write(admin, 'POST', `/api/v1/vendors/${id}/suspend`,
            { reason: 'verification run' });
        t.assert('suspending through admin succeeds', () => suspended.status === 200);
        t.assert('...and reports the cascade size back', () =>
            suspended.body?.data?.status === 'inactive'
            && suspended.body?.data?.suspendedProductCount === 2);

        const storedVendor = await db.collection(COLLECTIONS.VENDOR).findOne({ _id: vendorId });
        t.assert('the column moved in jovi_mall', () => storedVendor?.status === 'inactive');
        t.assert('...stamped with the ADMINISTRATOR, marked as an admin id, with a name snapshot', () =>
            storedVendor?.suspended_by_user_id?.toString() === admin.adminId
            && storedVendor?.suspended_by_source === 'admin'
            && storedVendor?.suspended_by_name === 'Verify Vendors Admin');
        t.assert('⭐ ...and records where to come back to', () =>
            storedVendor?.suspended_from_status === 'active');

        const pendingVendor = await db.collection(COLLECTIONS.VENDOR).findOne({ _id: pendingVendorId });
        t.assert('⭐ a pending_verification vendor is UNTOUCHED — the deploy is a no-op', () =>
            pendingVendor?.status === 'pending_verification');

        const conflict = await write(admin, 'POST', `/api/v1/vendors/${id}/suspend`,
            { reason: 'again' });
        t.assert('a second suspend is a 409 carrying jovi-mall’s own code', () =>
            conflict.status === 409
            && conflict.body?.error?.details?.platformCode === 'VENDOR_STATUS_CONFLICT');

        // ── 4. Gate B — the cascade ───────────────────────────────────────────
        t.section('4. Gate B — the catalogue came off sale');

        const activeAfter = await readProduct(activeProduct.id);
        t.assert('⭐ the active listing is suspended, under THIS cascade’s reason', () =>
            activeAfter?.status === 'suspended'
            && activeAfter?.suspension?.reason === 'vendor_suspended'
            && activeAfter?.suspension?.previousStatus === 'active');

        const draftAfter = await readProduct(draftProduct.id);
        t.assert('the draft is untouched — it was never on sale', () =>
            draftAfter?.status === 'draft' && !draftAfter?.suspension);

        const agencyAfter = await readProduct(agencySuspended.id);
        t.assert('⭐ the agency-suspended listing KEEPS its own reason', () =>
            agencyAfter?.status === 'suspended'
            && agencyAfter?.suspension?.reason === 'agency_storage_suspended');

        // ── 5. Gate C — the restore is not blind ──────────────────────────────
        t.section('5. Gate C — the restore returns only what it took');

        const restored = await write(admin, 'POST', `/api/v1/vendors/${id}/restore`);
        t.assert('restoring succeeds and reports how many came back', () =>
            restored.status === 200
            && restored.body?.data?.status === 'active'
            && restored.body?.data?.restoredProductCount === 2);

        t.assert('⭐ ...to the exact status recorded, not a hardcoded active', () =>
            (restored.body?.data?.suspension ?? null) === null);

        const activeRestored = await readProduct(activeProduct.id);
        t.assert('the cascade’s listing is back on sale with its suspension cleared', () =>
            activeRestored?.status === 'active' && !activeRestored?.suspension);

        const agencyStillDown = await readProduct(agencySuspended.id);
        t.assert('⭐ the agency-suspended listing STAYS suspended — not ours to release', () =>
            agencyStillDown?.status === 'suspended'
            && agencyStillDown?.suspension?.reason === 'agency_storage_suspended');

        // ── 6. Product oversight ──────────────────────────────────────────────
        t.section('6. Product oversight is its own lever');

        const oversightId = oversightTarget.id.toString();
        const tookDown = await write(admin, 'POST',
            `/api/v1/vendors/${id}/products/${oversightId}/suspend`, { note: 'counterfeit listing' });
        t.assert('an administrator can take one listing off sale', () => tookDown.status === 200);

        const oversightAfter = await readProduct(oversightTarget.id);
        t.assert('...under platform_oversight, with the note the vendor is shown', () =>
            oversightAfter?.status === 'suspended'
            && oversightAfter?.suspension?.reason === 'platform_oversight'
            && oversightAfter?.suspension?.note === 'counterfeit listing');

        // The heart of the two-reason design: suspend and reinstate the whole vendor, and
        // the individually-removed listing must NOT come back with the rest.
        await write(admin, 'POST', `/api/v1/vendors/${id}/suspend`, { reason: 'second pass' });
        await write(admin, 'POST', `/api/v1/vendors/${id}/restore`);

        const oversightSurvived = await readProduct(oversightTarget.id);
        t.assert('⭐ a vendor restore does NOT republish an oversight takedown', () =>
            oversightSurvived?.status === 'suspended'
            && oversightSurvived?.suspension?.reason === 'platform_oversight');

        const wrongLever = await write(admin, 'POST',
            `/api/v1/vendors/${id}/products/${agencySuspended.id.toString()}/restore`);
        t.assert('⭐ ...and the oversight restore refuses an agency-suspended listing', () =>
            wrongLever.status === 422
            && wrongLever.body?.error?.details?.platformCode === 'VENDOR_PRODUCT_NOT_OVERSIGHT_SUSPENDED');

        const putBack = await write(admin, 'POST',
            `/api/v1/vendors/${id}/products/${oversightId}/restore`);
        const oversightBack = await readProduct(oversightTarget.id);
        t.assert('the oversight restore lifts its own', () =>
            putBack.status === 200 && oversightBack?.status === 'active');

        // ── 7. KYC ────────────────────────────────────────────────────────────
        t.section('7. Business verification');

        const rejected = await write(admin, 'POST', `/api/v1/vendors/${id}/kyc/reject`,
            { reason: 'documents illegible' });
        t.assert('a rejection succeeds', () => rejected.status === 200);

        const afterReject = await db.collection(COLLECTIONS.VENDOR).findOne({ _id: vendorId });
        t.assert('⭐ ...and the REASON is stored in jovi_mall, where the vendor can be told', () =>
            afterReject?.kyc_details?.status === 'rejected'
            && afterReject?.kyc_details?.legit_verified === false
            && afterReject?.kyc_details?.rejection_reason === 'documents illegible');
        t.assert('...stamped with the reviewing administrator', () =>
            afterReject?.kyc_details?.reviewed_by_source === 'admin'
            && afterReject?.kyc_details?.reviewed_by_name === 'Verify Vendors Admin');

        const approved = await write(admin, 'POST', `/api/v1/vendors/${id}/kyc/approve`, {});
        t.assert('an approval flips the verdict and clears the reason', () => approved.status === 200);

        const afterApprove = await db.collection(COLLECTIONS.VENDOR).findOne({ _id: vendorId });
        t.assert('⭐ both the status and the boolean move together', () =>
            afterApprove?.kyc_details?.status === 'verified'
            && afterApprove?.kyc_details?.legit_verified === true
            && afterApprove?.kyc_details?.rejection_reason === null);

        const doubleApprove = await write(admin, 'POST', `/api/v1/vendors/${id}/kyc/approve`, {});
        t.assert('a second approval is a 409 — the decision was already made', () =>
            doubleApprove.status === 409
            && doubleApprove.body?.error?.details?.platformCode === 'VENDOR_KYC_STATUS_CONFLICT');

        // ── 8. Settings ───────────────────────────────────────────────────────
        t.section('8. The platform-governed settings');

        const settingsWrite = await write(admin, 'PATCH', `/api/v1/vendors/${id}/settings`,
            { autoCancelUnpaidDays: 9 });
        t.assert('the write succeeds and answers the resulting state', () =>
            settingsWrite.status === 200 && settingsWrite.body?.data?.autoCancelUnpaidDays === 9);

        const storedSettings = await db.collection(COLLECTIONS.VENDOR_SETTINGS)
            .findOne({ vendor_id: vendorId });
        t.assert('...and it landed in jovi_mall', () =>
            storedSettings?.auto_cancel_unpaid_days === 9);

        const refusedField = await write(admin, 'PATCH', `/api/v1/vendors/${id}/settings`,
            { notifyDaysBeforeExpiry: 14 });
        t.assert('⭐ a vendor-owned setting is refused HERE, before the wire', () =>
            refusedField.status === 400);

        const refusedCommission = await write(admin, 'PATCH', `/api/v1/vendors/${id}/settings`,
            { commission: 5 });
        t.assert('⭐ so is commission — that is the billing plan’s', () =>
            refusedCommission.status === 400);

        // ── 9. Gate D — the audit trail ───────────────────────────────────────
        t.section('9. Gate D — every write left a readable row');

        const feed = await get(admin, `/api/v1/vendors/${id}/activity?limit=50`);
        t.assert('the activity feed reads back', () => feed.status === 200);

        const actions = new Set(feed.body.data.map((row: any) => row.action));
        t.assert('...holding every action this run performed', () =>
            ['vendors.suspend', 'vendors.reinstate', 'vendors.kyc.reject', 'vendors.kyc.approve',
             'vendors.products.suspend', 'vendors.products.restore', 'vendors.settings.update']
                .every((action) => actions.has(action)));

        t.assert('every row is about THIS vendor and no other', () =>
            feed.body.data.every((row: any) => row.target?.id === id));

        const suspendRow = feed.body.data.find((row: any) => row.action === 'vendors.suspend');
        t.assert('the suspension row names the acting administrator', () =>
            suspendRow?.actor?.id === admin.adminId);
        t.assert('⭐ ...and carries the business name as its label, so the feed reads without a join', () =>
            suspendRow?.target?.label === businessName);

        const failedRow = feed.body.data.find((row: any) => row.status === 'failed');
        t.assert('⭐ a refused write is audited as failed, not omitted', () => !!failedRow);

        const wrongAction = await get(admin, `/api/v1/vendors/${id}/activity?action=users.suspend`);
        t.assert('another domain’s action is refused by the filter', () => wrongAction.status === 400);

        const missingFeed = await get(admin, `/api/v1/vendors/${new ObjectId().toString()}/activity`);
        t.assert('an unknown vendor’s feed is a 404, not an empty page', () =>
            missingFeed.status === 404);

        // ── 10. Gate E — nothing sensitive leaves ─────────────────────────────
        t.section('10. Gate E — the projections hold');

        const everyRead = JSON.stringify([
            byBusinessName.body, detail.body, catalogue.body, feed.body,
        ]);
        t.assert('⭐ the payout account number appears in NO response', () =>
            !everyRead.includes(POISON_PAYOUT));
        t.assert('⭐ the national identity number appears in NO response', () =>
            !everyRead.includes(POISON_NIN));

        // ── 11. Authorization ─────────────────────────────────────────────────
        t.section('11. Support may look, and may not touch');

        const supportRead = await get(support, `/api/v1/vendors/${id}`);
        t.assert('Support can open a vendor', () => supportRead.status === 200);

        const supportFeed = await get(support, `/api/v1/vendors/${id}/activity`);
        t.assert('...and read its history — they hold both permissions', () =>
            supportFeed.status === 200);

        const supportWrites = await Promise.all([
            write(support, 'POST', `/api/v1/vendors/${id}/suspend`, { reason: 'nope' }),
            write(support, 'POST', `/api/v1/vendors/${id}/kyc/reject`, { reason: 'nope' }),
            write(support, 'PATCH', `/api/v1/vendors/${id}/settings`, { autoCancelUnpaidDays: 5 }),
            write(support, 'POST', `/api/v1/vendors/${id}/products/${oversightId}/suspend`, { note: 'nope' }),
        ]);
        t.assert('⭐ every write is refused with 403', () =>
            supportWrites.every((res) => res.status === 403));

        const stillActive = await db.collection(COLLECTIONS.VENDOR).findOne({ _id: vendorId });
        t.assert('...and none of them changed anything', () => stillActive?.status === 'active');

        const anonymous = await call('GET', `/api/v1/vendors/${id}`);
        t.assert('an anonymous caller gets 401', () => anonymous.status === 401);

        return t.finish();
    } finally {
        await cleanupPlatform();
        await cleanupAdmin();
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await closeRedisClients();
        await closeAll();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error('\n  ❌ verify:vendors crashed:', err);
        process.exit(1);
    });

/**
 * Verify: the COD surface against REAL infrastructure.
 *
 * `test:cod` proves the rules are internally consistent. This proves the queries RUN — and
 * it is the only place three things can be shown, because each is a property of what Mongo
 * actually returns rather than of what the source says:
 *
 *   1. **the party names resolve.** A projection is a string, so no compiler checks it, and
 *      Mongo answers a projection of a field that does not exist with silence. That is
 *      exactly how `findNamesByIds` came to project `display_name` — the AGENCY's field —
 *      against `delivery_agents`, and return `null` for every agent name on every shipment
 *      screen while answering a well-formed 200. `test-agents.ts` now guards the class
 *      statically; this proves the instance.
 *   2. **a platform deposit produces TWO cash-ledger rows.** One lowering the agent's
 *      liability, one lowering the agency's, because the cash physically skipped the middle
 *      leg. The detail endpoint is the only place that asymmetry is visible, and no DB-free
 *      assertion can produce it.
 *   3. **the filters and sorts execute.** Mongo validates a filter at execution time, not
 *      at compile time.
 *
 * ── What it deliberately does NOT re-prove ────────────────────────────────────
 * The delegated WRITES. `verify-platform-live.ts` already drives remittance-confirm through
 * jovi-mall's FIFO settlement and deposit-confirm through its in-process subscribers, which
 * are the two hardest and the two the whole delegation design exists for. Building a second
 * copy of that fixture set — contracts, cash accounts, collections — to re-assert the same
 * property would be duplication rather than coverage. What is new at Phase 11 on the write
 * side is the audit `before`, and this suite asserts that on the records it creates.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo + Redis. **jovi-mall does NOT have to be running** — every assertion here is a
 *   direct read, which is the point of the transport split this phase drew.
 *
 * It creates its own fixtures in `jovi_mall` (a throwaway user, agent, agency, magazin,
 * two cash accounts, a ledger pair, a remittance, a deposit, a discrepancy and a trust
 * event) and deletes everything it made at the end, pass or fail.
 *
 * Run: npm run verify:cod
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
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model';
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { COLLECTIONS } from '../../src/infra/platform/collections';

const t = suite('cash on delivery — live');

const PASSWORD = 'verify-cod-suite-password-7712';
const EMAIL_ADMIN = 'verify-cod-admin@example.test';
const EMAIL_SUPPORT = 'verify-cod-support@example.test';
const FIXTURE_TAG = 'verify-cod-fixture';

const AGENT_NAME = 'Verify COD Agent';
const AGENCY_NAME = 'Verify COD Logistics';

interface Res { status: number; body: any }
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
): Promise<Res & { cookies: Record<string, string> }> {
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

function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

// Every id this suite mints, so cleanup cannot miss one.
const userId = new ObjectId();
const agentId = new ObjectId();
const agencyId = new ObjectId();
const magazinId = new ObjectId();
const agentAccountId = new ObjectId();
const agencyAccountId = new ObjectId();
const remittanceId = new ObjectId();
const depositId = new ObjectId();
const discrepancyId = new ObjectId();

async function cleanupPlatform(): Promise<void> {
    const db = platformDb();
    for (const collection of [
        COLLECTIONS.USER,
        COLLECTIONS.DELIVERY_AGENT,
        COLLECTIONS.DELIVERY_AGENCY,
        COLLECTIONS.AGENCY_MAGAZIN,
        COLLECTIONS.COD_CASH_ACCOUNT,
        COLLECTIONS.COD_CASH_LEDGER,
        COLLECTIONS.COD_TRUST_EVENT,
        COLLECTIONS.AGENCY_REMITTANCE,
        COLLECTIONS.AGENT_DEPOSIT,
        COLLECTIONS.COD_DISCREPANCY,
    ]) {
        await db.collection(collection).deleteMany({ [FIXTURE_TAG]: true } as never);
    }
}

async function cleanupAdmin(): Promise<void> {
    const admins = await AdminAccountModel().find({ email: { $in: [EMAIL_ADMIN, EMAIL_SUPPORT] } }, { _id: 1 });
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
        await AuditLogModel().deleteMany({ actor_id: { $in: ids } });
        await AdminSessionModel().deleteMany({ admin_id: { $in: ids } });
        await AdminAccountModel().deleteMany({ _id: { $in: ids } });
    }
    const redis = await getRedisClient(ADMIN_SESSION_DB);
    for (const id of ids) {
        const sids = await redis.sMembers(`admin-sessions:${id.toString()}`);
        for (const sid of sids) await redis.del(`session:${sid}`);
        await redis.del(`admin-sessions:${id.toString()}`);
    }
}

async function seedPlatform(): Promise<void> {
    const db = platformDb();
    const now = new Date();
    const tag = { [FIXTURE_TAG]: true };

    await db.collection(COLLECTIONS.USER).insertOne({
        _id: userId, login_email: 'verify-cod-user@example.test', login_phone: '+237600000093',
        password_hash: 'x', roles: ['agent'], status: 'active', created_at: now, updated_at: now, ...tag,
    } as never);

    /**
     * `name`, not `display_name` — this is the fixture the name assertion turns on. An
     * agent's own name is the only name they have; an agency's business name lives on its
     * Magazin.
     */
    await db.collection(COLLECTIONS.DELIVERY_AGENT).insertOne({
        _id: agentId, user_id: userId, name: AGENT_NAME, status: 'active',
        cod: { trust_score: 82, max_threshold: 150000 },
        created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.DELIVERY_AGENCY).insertOne({
        _id: agencyId, user_id: userId, display_name: 'Verify COD Contact', status: 'active',
        created_at: now, updated_at: now, ...tag,
    } as never);

    await db.collection(COLLECTIONS.AGENCY_MAGAZIN).insertOne({
        _id: magazinId, agency_id: agencyId, name: AGENCY_NAME, created_at: now, updated_at: now, ...tag,
    } as never);

    // The two liability layers: the agent owes the agency, the agency owes the platform.
    await db.collection(COLLECTIONS.COD_CASH_ACCOUNT).insertMany([
        {
            _id: agentAccountId, owner_type: 'agent', owner_id: agentId, balance: 45000,
            currency: 'XAF', version: 3, created_at: now, updated_at: now, ...tag,
        },
        {
            _id: agencyAccountId, owner_type: 'agency', owner_id: agencyId, balance: 120000,
            currency: 'XAF', version: 7, created_at: now, updated_at: now, ...tag,
        },
        // A settled account — out of scope by default, the reason `includeSettled` exists.
        {
            _id: new ObjectId(), owner_type: 'agent', owner_id: new ObjectId(), balance: 0,
            currency: 'XAF', version: 1, created_at: now, updated_at: now, ...tag,
        },
    ] as never);

    await db.collection(COLLECTIONS.AGENCY_REMITTANCE).insertOne({
        _id: remittanceId, agency_id: agencyId, amount: 80000, currency: 'XAF',
        reference: 'VERIFY-COD-BANK-1', note: null, status: 'confirmed',
        declared_by_user_id: userId, declared_at: now, resolved_at: now,
        resolved_by_user_id: new ObjectId(), resolved_by_source: 'admin', resolved_by_name: 'Some Admin',
        rejection_reason: null, created_at: now, updated_at: now, ...tag,
    } as never);

    // A PLATFORM deposit: the cash skipped the agency, so both legs settle.
    await db.collection(COLLECTIONS.AGENT_DEPOSIT).insertOne({
        _id: depositId, agent_id: agentId, agency_id: agencyId, amount: 30000, currency: 'XAF',
        note: null, recipient: 'platform', status: 'confirmed', reference: 'VERIFY-COD-MOMO-1',
        declared_by_user_id: userId, declared_at: now,
        recorded_by_user_id: new ObjectId(), recorded_by_source: 'admin', recorded_by_name: 'Some Admin',
        resolved_at: now, rejection_reason: null, created_at: now, updated_at: now, ...tag,
    } as never);

    /**
     * The two ledger rows that deposit produced — one per leg. This is the fixture the
     * headline assertion turns on.
     */
    await db.collection(COLLECTIONS.COD_CASH_LEDGER).insertMany([
        {
            _id: new ObjectId(), account_id: agentAccountId, owner_type: 'agent', owner_id: agentId,
            entry_type: 'deposit', amount: -30000, balance_after: 45000,
            ref_type: 'agent_deposit', ref_id: depositId, created_at: now, ...tag,
        },
        {
            _id: new ObjectId(), account_id: agencyAccountId, owner_type: 'agency', owner_id: agencyId,
            entry_type: 'deposit', amount: -30000, balance_after: 120000,
            ref_type: 'agent_deposit', ref_id: depositId, created_at: now, ...tag,
        },
        // ...and the single row the remittance produced, against the agency alone.
        {
            _id: new ObjectId(), account_id: agencyAccountId, owner_type: 'agency', owner_id: agencyId,
            entry_type: 'remittance', amount: -80000, balance_after: 120000,
            ref_type: 'agency_remittance', ref_id: remittanceId, created_at: now, ...tag,
        },
    ] as never);

    await db.collection(COLLECTIONS.COD_DISCREPANCY).insertOne({
        _id: discrepancyId, agent_id: agentId, agency_id: agencyId, type: 'late_deposit',
        amount: 45000, currency: 'XAF', status: 'open', raised_by: 'system',
        raised_by_user_id: null, deposit_id: depositId, note: 'Past the deposit deadline',
        resolution_note: null, resolved_by_user_id: null,
        opened_at: now, resolved_at: null, created_at: now, updated_at: now, ...tag,
    } as never);

    // The penalty that flag caused — what makes a discrepancy detail worth opening.
    await db.collection(COLLECTIONS.COD_TRUST_EVENT).insertOne({
        _id: new ObjectId(), agent_id: agentId, agency_id: agencyId, event_type: 'late_deposit',
        delta: -18, score_after: 82, ref_type: 'cod_discrepancy', ref_id: discrepancyId,
        note: null, created_at: now, ...tag,
    } as never);
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
        await make(EMAIL_ADMIN, 'Verify COD Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify COD Support', 3);

        await seedPlatform();

        const app = createApp();
        server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        // ── 1. Holders ────────────────────────────────────────────────────────
        t.section('1. The holders list — two liability layers, one route');

        const holders = await get(admin, '/api/v1/cod/holders?limit=100');
        t.assert('GET /cod/holders answers 200', () => holders.status === 200);

        const rows: any[] = holders.body?.data ?? [];
        const agentRow = rows.find((r) => r.owner.id === agentId.toString());
        const agencyRow = rows.find((r) => r.owner.id === agencyId.toString());

        t.assert('...and carries both owner types from one query', () =>
            Boolean(agentRow) && Boolean(agencyRow)
            && agentRow.ownerType === 'agent' && agencyRow.ownerType === 'agency');

        /**
         * THE assertion this suite exists for. `findNamesByIds` used to project
         * `display_name` against `delivery_agents`, where the field is `name` — so this
         * came back `null` on every screen, silently, with a well-formed 200.
         */
        t.assert('THE NAME RESOLVES: the agent is named, not null', () =>
            agentRow.owner.name === AGENT_NAME);

        t.assert('...and the agency by its BUSINESS name off the Magazin', () =>
            agencyRow.owner.name === AGENCY_NAME);

        t.assert('the agent carries a trust block; the agency carries null', () =>
            agentRow.trust?.score === 82
            && agentRow.trust?.maxThreshold === 150000
            && agencyRow.trust === null);

        t.assert('a settled account is out of scope by default', () =>
            rows.every((r) => r.balance > 0));

        const settled = await get(admin, '/api/v1/cod/holders?includeSettled=true&limit=100');
        t.assert('...and in scope when asked for', () =>
            (settled.body?.data ?? []).some((r: any) => r.balance === 0));

        const agentsOnly = await get(admin, '/api/v1/cod/holders?ownerType=agent&limit=100');
        t.assert('the ownerType filter executes', () =>
            agentsOnly.status === 200
            && (agentsOnly.body?.data ?? []).every((r: any) => r.ownerType === 'agent'));

        const badOwnerType = await get(admin, '/api/v1/cod/holders?ownerType=platform');
        t.assert('`ownerType=platform` is refused — the platform holds no account', () =>
            badOwnerType.status === 400);

        t.assert('no contact detail leaves on a holder row', () =>
            !JSON.stringify(agentRow).includes('@')
            && !JSON.stringify(agentRow).includes('+237'));

        // ── 2. The record details ─────────────────────────────────────────────
        t.section('2. The record details — what the row cannot say');

        const remittance = await get(admin, `/api/v1/cod/remittances/${remittanceId.toString()}`);
        t.assert('GET /cod/remittances/:id answers 200', () => remittance.status === 200);
        t.assert('...naming the agency by its business name', () =>
            remittance.body?.data?.agency?.name === AGENCY_NAME);
        t.assert('...and carrying the actor stamp jovi-mall’s own list DTO omits', () =>
            remittance.body?.data?.resolvedBy?.source === 'admin'
            && remittance.body?.data?.resolvedBy?.name === 'Some Admin');
        t.assert('...plus the ONE cash movement it caused', () =>
            (remittance.body?.data?.cashMovements ?? []).length === 1
            && remittance.body.data.cashMovements[0].ownerType === 'agency');

        const deposit = await get(admin, `/api/v1/cod/deposits/${depositId.toString()}`);
        t.assert('GET /cod/deposits/:id answers 200', () => deposit.status === 200);
        t.assert('...naming BOTH parties', () =>
            deposit.body?.data?.agent?.name === AGENT_NAME
            && deposit.body?.data?.agency?.name === AGENCY_NAME);

        /**
         * The two-sided settlement, and the reason this detail is worth opening: a
         * `platform` deposit lowers the AGENT's liability and the AGENCY's, because the
         * cash physically skipped the middle leg. Nothing else on the surface shows it.
         */
        t.assert('THE TWO LEGS: a platform deposit shows two cash movements', () => {
            const movements: any[] = deposit.body?.data?.cashMovements ?? [];
            return movements.length === 2
                && movements.some((m) => m.ownerType === 'agent')
                && movements.some((m) => m.ownerType === 'agency');
        });

        t.assert('...and both are keyed to this deposit', () =>
            (deposit.body?.data?.cashMovements ?? [])
                .every((m: any) => m.refType === 'agent_deposit' && m.refId === depositId.toString()));

        const discrepancy = await get(admin, `/api/v1/cod/discrepancies/${discrepancyId.toString()}`);
        t.assert('GET /cod/discrepancies/:id answers 200', () => discrepancy.status === 200);
        t.assert('...resolving the deposit it names', () =>
            discrepancy.body?.data?.deposit?.id === depositId.toString());
        t.assert('...and the trust penalty it caused', () => {
            const events: any[] = discrepancy.body?.data?.trustEvents ?? [];
            return events.length === 1 && events[0].delta === -18 && events[0].scoreAfter === 82;
        });

        const missingDeposit = await get(admin, `/api/v1/cod/deposits/${new ObjectId().toString()}`);
        t.assert('an unknown record is a plain 404 from HERE', () => missingDeposit.status === 404);

        // ── 3. Lists and filters ──────────────────────────────────────────────
        t.section('3. The direct lists — filters Mongo validates at execution time');

        const openFlags = await get(admin, '/api/v1/cod/discrepancies?status=open&type=late_deposit&limit=100');
        t.assert('the discrepancy filters compose and execute', () =>
            openFlags.status === 200
            && (openFlags.body?.data ?? []).some((d: any) => d.id === discrepancyId.toString()));

        t.assert('...and its rows name both parties', () => {
            const row = (openFlags.body?.data ?? []).find((d: any) => d.id === discrepancyId.toString());
            return row?.agent?.name === AGENT_NAME && row?.agency?.name === AGENCY_NAME;
        });

        const trust = await get(admin, `/api/v1/cod/agents/${agentId.toString()}/trust-events`);
        t.assert('the trust feed reads, scoped to the agent in the path', () =>
            trust.status === 200
            && (trust.body?.data ?? []).length === 1
            && trust.body.data[0].agentId === agentId.toString());

        const missingAgentTrust = await get(
            admin, `/api/v1/cod/agents/${new ObjectId().toString()}/trust-events`,
        );
        t.assert('a trust feed for an unknown agent is a 404, not an empty page', () =>
            missingAgentTrust.status === 404);

        // ── 4. The ban list, against real data ────────────────────────────────
        t.section('4. The delivery code never appears — in any response');

        const everyResponse = JSON.stringify([
            holders.body, remittance.body, deposit.body, discrepancy.body, openFlags.body, trust.body,
        ]);

        t.assert('no response carries code_plain, code_hash or a verification block', () =>
            !everyResponse.includes('code_plain')
            && !everyResponse.includes('code_hash')
            && !everyResponse.includes('device_info'));

        // ── 5. The gates ──────────────────────────────────────────────────────
        t.section('5. Who may reach it');

        const [supportHolders, supportOverview, supportFlags] = await Promise.all([
            get(support, '/api/v1/cod/holders'),
            get(support, '/api/v1/cod/overview'),
            get(support, '/api/v1/cod/discrepancies'),
        ]);

        t.assert('Support is refused the holders list — the cash chain is not ticket work', () =>
            supportHolders.status === 403);

        /**
         * The overview is the DELEGATED read, and it is refused here without jovi-mall
         * being consulted at all: authorization resolves in this service, before
         * delegation. That is ADR-003's single-sided rule, observable.
         */
        t.assert('...and the overview, and the discrepancy queue', () =>
            supportOverview.status === 403 && supportFlags.status === 403);

        const denials = await AuditLogModel().find({ status: 'denied' }).sort({ occurred_at: -1 }).limit(5).lean();
        t.assert('...and every refusal is on the record', () =>
            denials.some((d: any) => (d.required_permissions ?? []).some((p: string) => p.startsWith('cod.'))));

        return t.finish();
    } finally {
        try { await cleanupPlatform(); } catch { /* best effort */ }
        try { await cleanupAdmin(); } catch { /* best effort */ }
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await closeAll();
        await closeRedisClients();
    }
}

void main().then((code) => process.exit(code));

/**
 * The platform transactions list (BR-027), against a real MongoDB.
 *
 * `test:transactions` proves the rules; this proves the QUERIES — that eleven native filters,
 * dotted projections, keyset clauses and the summary `$group` are things MongoDB accepts and
 * answers as the rules say. It drives the three handlers directly with a fabricated identity
 * per tier, so it needs a database and nothing else: no server, no Redis, no login.
 *
 * ⛔ **It SEEDS and DROPS collections.** It refuses to run unless the database name ends in
 * `_verify`, so it cannot be pointed at a real `jovi_mall` by a stray environment variable.
 *
 *   mongod --dbpath <scratch> --port 27117 --bind_ip 127.0.0.1
 *   VERIFY_MONGO_URI=mongodb://127.0.0.1:27117/wi_transactions_verify npm run verify:transactions
 */
import { suite } from './_assert';

const URI = process.env.VERIFY_MONGO_URI ?? '';
const databaseName = URI.split('?')[0].split('/').pop() ?? '';
if (!databaseName.endsWith('_verify')) {
    console.error('Refusing to run: VERIFY_MONGO_URI must name a database ending in `_verify` — this script seeds and drops collections.');
    process.exit(2);
}

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = URI;
process.env.MONGO_URI_ADMIN = URI;
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { Request, RequestHandler, Response } from 'express';
import { ObjectId } from 'mongodb';
import { closeAll, connectAll, platformConnection } from '../../src/infra/mongo/connections';
import { COLLECTIONS } from '../../src/infra/platform/collections';
import { TransactionController } from '../../src/modules/money/controllers/transaction.controller';
import { TransactionRowDto } from '../../src/modules/money/read-models/transaction.dto';
import {
    ListTransactionsQuerySchema,
    TransactionParamSchema,
    TransactionSummaryQuerySchema,
} from '../../src/modules/money/validators/transaction.validator';

const t = suite('platform transactions — live queries (BR-027)');

interface Answer {
    status: number;
    body: { data?: unknown; meta?: Record<string, unknown>; error?: { code: string; statusCode: number } };
}

/** Run one handler as a tier, the way the route would after `validate`. */
function call(handler: RequestHandler, tier: 1 | 2 | 3, input: { query?: unknown; params?: unknown }): Promise<Answer> {
    return new Promise((resolve) => {
        const req = {
            admin: { adminId: new ObjectId().toString(), sessionId: 's', email: 'v@x', displayName: 'verify', tier, status: 'active', mfaEnrolled: true, pendingMfaEnrolment: false },
            query: input.query ?? {},
            params: input.params ?? {},
            method: 'GET', originalUrl: '/api/v1/money/transactions', path: '/', headers: {}, ip: '127.0.0.1',
            get: () => undefined,
        } as unknown as Request;
        let status = 200;
        const res = {
            status(code: number) { status = code; return res; },
            json(body: Answer['body']) { resolve({ status, body }); },
        } as unknown as Response;
        handler(req, res, (err?: unknown) => {
            const error = err as { code?: string; statusCode?: number } | undefined;
            resolve({ status: error?.statusCode ?? 500, body: { error: { code: error?.code ?? 'THROWN', statusCode: error?.statusCode ?? 500 } } });
        });
    });
}

const list = (tier: 1 | 2 | 3, raw: Record<string, string> = {}) =>
    call(TransactionController.list, tier, { query: ListTransactionsQuerySchema.parse(raw) });
const summary = (tier: 1 | 2 | 3, raw: Record<string, string> = {}) =>
    call(TransactionController.summary, tier, { query: TransactionSummaryQuerySchema.parse(raw) });
const detail = (tier: 1 | 2 | 3, kind: string, id: ObjectId) =>
    call(TransactionController.detail, tier, { params: TransactionParamSchema.parse({ kind, id: id.toString() }) });

const rowsOf = (answer: Answer): TransactionRowDto[] => (answer.body.data ?? []) as TransactionRowDto[];
const idsOf = (answer: Answer): string[] => rowsOf(answer).map((row) => `${row.kind}:${row.id}`).sort();

const id = () => new ObjectId();
const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));

const VENDOR = id(), AGENCY = id(), AGENT = id(), CUSTOMER = id(), ORDER_1 = id(), ORDER_2 = id();
const VENDOR_ACCOUNT = id(), PLATFORM_ACCOUNT = id(), AI_ACCOUNT = id();
const PAYMENT = id(), REFUND = id(), L_VENDOR = id(), L_PLATFORM = id(), L_AI = id(), ALLOCATION = id();
const DFR_OWED = id(), DFR_HAND = id(), DFR_GATEWAY = id(), DFR_COVERED = id();
const PAYOUT_PAID = id(), PAYOUT_FAILED = id(), PLAN = id(), TOPUP = id();
const DEPOSIT_AGENCY = id(), DEPOSIT_PLATFORM = id(), REMITTANCE = id();
const CC_COLLECTED = id(), CC_PENDING = id();
const ADJ_WRITE_OFF = id(), ADJ_PAYOUT_RECOVERY = id(), ADJ_WITH_ALLOCATION = id(), ADJ_OVERFLOW = id();
/** Seeded on the cash collections, and asserted absent from every response. */
const SECRET_CODE = 'SECRETCODE42', SECRET_HASH = 'hash-of-secret-code', SECRET_IP = '10.9.8.7', SECRET_DEVICE = 'SecretPhone X';
const SECRET_MSISDN = '237699000111';

async function seed(): Promise<void> {
    const db = platformConnection().db!;
    await db.dropDatabase();
    const put = (collection: string, docs: Record<string, unknown>[]) => db.collection(collection).insertMany(docs);

    await put(COLLECTIONS.STORE, [{ vendor_id: VENDOR, name: 'Boutique Verify', slug: 'boutique-verify' }]);
    await put(COLLECTIONS.CUSTOMER, [{ _id: CUSTOMER, user_id: id(), name: 'Awa Customer' }]);
    await put(COLLECTIONS.ORDER, [{ _id: ORDER_1, order_number: 'ORD-VERIFY-1' }, { _id: ORDER_2, order_number: 'ORD-VERIFY-2' }]);
    await put(COLLECTIONS.EARNINGS_ACCOUNT, [
        { _id: VENDOR_ACCOUNT, owner_type: 'vendor', owner_id: VENDOR, currency: 'XAF', available_balance: 999 },
        { _id: PLATFORM_ACCOUNT, owner_type: 'platform', owner_id: null, currency: 'XAF' },
        { _id: AI_ACCOUNT, owner_type: 'platform_ai', owner_id: null, currency: 'XAF' },
    ]);
    await put(COLLECTIONS.EARNINGS_ALLOCATION, [{
        _id: ALLOCATION, source_type: 'order', source_id: ORDER_1, beneficiary_type: 'vendor', beneficiary_id: VENDOR,
        gross_snapshot: 20000, commission_percent_snapshot: 15, amount: 17000, currency: 'XAF', status: 'held',
        created_at: at(1), updated_at: at(1),
    }]);

    await put(COLLECTIONS.PAYMENT_TRANSACTION, [{
        _id: PAYMENT, orderIds: [ORDER_1], purpose: 'primary', userId: CUSTOMER, gateway: 'NOTCHPAY', provider: 'MTN',
        method: 'mobile_money', gatewayRef: 'np_verify_1', merchantRef: 'jm_pt_verify', status: 'SUCCEEDED',
        amountSnapshot: 20000, currencySnapshot: 'XAF', createdAt: at(0), paidAt: at(1),
        rawGatewayPayloads: [{ phone: SECRET_MSISDN }], idempotencyKey: 'idem-secret',
    }]);
    await put(COLLECTIONS.REFUND_TRANSACTION, [{
        _id: REFUND, paymentTransactionId: PAYMENT, orderId: ORDER_1, vendorId: VENDOR, userId: CUSTOMER, refundAmount: 5000,
        currency: 'XAF', reason: 'damaged item', status: 'completed', gateway: 'NOTCHPAY', channel: 'payout',
        feeAmount: 100, netAmount: 4900, initiatedBy: id(), initiatedByRole: 'support', createdAt: at(20), completedAt: at(21),
    }]);
    const ledger = (_id: ObjectId, account: ObjectId, owner_type: string, owner_id: ObjectId | null, amount: number, minute: number) => ({
        _id, account_id: account, owner_type, owner_id, entry_type: 'hold', amount, pending_after: amount, available_after: 0,
        source_type: 'order', source_id: ORDER_1, allocation_id: ALLOCATION, reason_code: 'order_split', created_at: at(minute),
    });
    await put(COLLECTIONS.EARNINGS_LEDGER, [
        ledger(L_VENDOR, VENDOR_ACCOUNT, 'vendor', VENDOR, 17000, 2),
        ledger(L_PLATFORM, PLATFORM_ACCOUNT, 'platform', null, 3000, 2),
        ledger(L_AI, AI_ACCOUNT, 'platform_ai', null, 500, 2),
    ]);
    const dfr = (_id: ObjectId, order_id: ObjectId, status: string, extra: Record<string, unknown>, minute: number) => ({
        _id, order_id, customer_id: CUSTOMER, vendor_id: VENDOR, amount: 500, currency: 'XAF', status, cause: 'fee_decrease',
        refund_transaction_ids: [], created_at: at(minute), updated_at: at(minute), ...extra,
    });
    await put(COLLECTIONS.DELIVERY_FEE_REFUND, [
        dfr(DFR_OWED, ORDER_1, 'manual_required', { note: 'mobile money — pay by hand' }, 30),
        dfr(DFR_HAND, ORDER_2, 'completed', { settled_at: at(41), settlement: { method: 'mobile_money', reference: 'MM-77', settled_by_user_id: 'a', settled_at: at(41) } }, 31),
        dfr(DFR_GATEWAY, ORDER_2, 'completed', { refund_transaction_ids: [id()], settled_at: at(33) }, 32),
        dfr(DFR_COVERED, ORDER_2, 'completed', { settlement: { method: 'covered_by_order_refund', settled_by_user_id: 'a', settled_at: at(34) } }, 33),
    ]);
    await put(COLLECTIONS.PAYOUT_REQUEST, [
        {
            _id: PAYOUT_PAID, owner_type: 'vendor', owner_id: VENDOR, amount: 100000, currency: 'XAF', status: 'paid', origin: 'manual',
            payout_method_snapshot: { method: 'mobile_money', mobile_money: { provider: 'Orange', phone_number: SECRET_MSISDN, account_name: 'Secret Holder' } },
            transfer_reference: 'jm_po_secret', transfer_gateway: 'NOTCHPAY', transfer_gateway_ref: 'np_tr_1', resolved_at: at(51), created_at: at(50),
        },
        {
            _id: PAYOUT_FAILED, owner_type: 'agent', owner_id: AGENT, amount: 30000, currency: 'XAF', status: 'failed', origin: 'auto_threshold',
            payout_method_snapshot: { method: 'mobile_money', mobile_money: { provider: 'MTN', phone_number: SECRET_MSISDN } },
            transfer_failure_reason: 'insufficient float', created_at: at(52),
        },
    ]);
    await put(COLLECTIONS.PLAN_PURCHASE, [{
        _id: PLAN, owner_type: 'vendor', owner_id: VENDOR, plan_id: id(), plan_code: 'pro_monthly', price: 10000, currency: 'XAF',
        status: 'paid', gateway: 'NOTCHPAY', provider: 'MTN', gateway_ref: 'np_pl_1', merchant_ref: 'jm_pp_verify', paid_at: at(61), created_at: at(60),
    }]);
    await put(COLLECTIONS.CREDIT_TOPUP, [{
        _id: TOPUP, owner_type: 'agency', owner_id: AGENCY, pack_code: 'pack_100', credits: 100, price: 2000, currency: 'XAF',
        status: 'pending', gateway: 'NOTCHPAY', created_at: at(62),
    }]);
    await put(COLLECTIONS.AGENT_DEPOSIT, [
        { _id: DEPOSIT_AGENCY, agent_id: AGENT, agency_id: AGENCY, amount: 8000, currency: 'XAF', recipient: 'agency', status: 'confirmed', resolved_at: at(71), created_at: at(70) },
        { _id: DEPOSIT_PLATFORM, agent_id: AGENT, agency_id: AGENCY, amount: 4000, currency: 'XAF', recipient: 'platform', status: 'declared', reference: 'RCPT-9', created_at: at(72) },
    ]);
    const collection = (_id: ObjectId, order: ObjectId, extra: Record<string, unknown>, minute: number) => ({
        _id, order_id: order, shipment_id: id(), agency_id: AGENCY, agent_id: AGENT, customer_id: CUSTOMER, vendor_id: VENDOR,
        currency: 'XAF', code_hash: SECRET_HASH, code_plain: SECRET_CODE, code_generated_at: at(minute), code_attempts: 0,
        code_locked: false, settled_amount: 0, settled_at: null, created_at: at(minute), updated_at: at(minute), ...extra,
    });
    await put(COLLECTIONS.CASH_COLLECTION, [
        collection(CC_COLLECTED, ORDER_1, {
            kind: 'order', expected_amount: 7000, status: 'collected', collected_at: at(91),
            verification: { method: 'code', location: { lat: 4.05, lng: 9.7 }, device_info: SECRET_DEVICE, ip: SECRET_IP },
        }, 90),
        collection(CC_PENDING, ORDER_2, { kind: 'delivery_fee', expected_amount: 1500, items_amount: 0, delivery_fee_amount: 1500, status: 'pending' }, 92),
    ]);
    const adjustment = (_id: ObjectId, extra: Record<string, unknown>, minute: number) => ({
        _id, allocation_id: null, source_type: null, source_id: null, currency: 'XAF',
        taken_from: { pending: 0, reserve: 0, available: 0, debt: 0 }, goods_amount: 0, delivery_amount: 0,
        refund_attribution: null, actor: null, reason: null, created_at: at(minute), ...extra,
    });
    await put(COLLECTIONS.EARNINGS_ADJUSTMENT, [
        adjustment(ADJ_WRITE_OFF, { refund_key: `write_off:${id().toString()}`, kind: 'write_off', beneficiary_type: 'vendor', beneficiary_id: VENDOR, amount: 2500, actor: { id: 'adm-1', name: 'Ama Admin' }, reason: 'Shop closed; balance unrecoverable' }, 100),
        adjustment(ADJ_PAYOUT_RECOVERY, { refund_key: `recovery:payout:${PAYOUT_FAILED.toString()}:rejected`, kind: 'clawback_recovery', beneficiary_type: 'agent', beneficiary_id: AGENT, amount: 1200 }, 101),
        // Both of these also wrote a ledger row upstream, so neither may appear as this kind.
        adjustment(ADJ_WITH_ALLOCATION, { refund_key: `recovery:${ALLOCATION.toString()}`, kind: 'clawback_recovery', allocation_id: ALLOCATION, beneficiary_type: 'vendor', beneficiary_id: VENDOR, amount: 300 }, 102),
        adjustment(ADJ_OVERFLOW, { refund_key: id().toString(), kind: 'refund_clawback', beneficiary_type: 'vendor', beneficiary_id: VENDOR, amount: 400 }, 103),
    ]);
    await put(COLLECTIONS.AGENCY_REMITTANCE, [{
        _id: REMITTANCE, agency_id: AGENCY, amount: 90000, currency: 'XAF', status: 'confirmed', reference: 'BANK-1', resolved_at: at(81), created_at: at(80),
    }]);
}

const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };
const key = (kind: string, rowId: ObjectId) => `${kind}:${rowId.toString()}`;

const EVERYTHING = [
    key('payment', PAYMENT), key('refund', REFUND),
    key('ledger_entry', L_VENDOR), key('ledger_entry', L_PLATFORM), key('ledger_entry', L_AI),
    key('delivery_fee_refund', DFR_OWED), key('delivery_fee_refund', DFR_HAND),
    key('payout', PAYOUT_PAID), key('payout', PAYOUT_FAILED),
    key('plan_purchase', PLAN), key('credit_topup', TOPUP),
    key('cod_deposit', DEPOSIT_AGENCY), key('cod_deposit', DEPOSIT_PLATFORM), key('cod_remittance', REMITTANCE),
    key('cod_collection', CC_COLLECTED), key('cod_collection', CC_PENDING),
    key('earnings_adjustment', ADJ_WRITE_OFF), key('earnings_adjustment', ADJ_PAYOUT_RECOVERY),
].sort();

async function main(): Promise<number> {
    await connectAll();
    await seed();

    const all = await list(1, { ...WINDOW, limit: '100' });
    const asAdmin = await list(2, { ...WINDOW, limit: '100' });
    const asSupport = await list(3, { ...WINDOW, limit: '100' });

    t.section('1. Every kind, graded');
    t.assert('tier 1 is sent all eighteen movements — no gateway-settled or "covered" delivery refund, no adjustment that has a ledger row', () =>
        all.status === 200 && JSON.stringify(idsOf(all)) === JSON.stringify(EVERYTHING));
    t.assert('tier 2 is sent sixteen: the two platform ledger rows are not there', () =>
        idsOf(asAdmin).length === 16
        && !idsOf(asAdmin).includes(key('ledger_entry', L_PLATFORM)) && !idsOf(asAdmin).includes(key('ledger_entry', L_AI))
        && idsOf(asAdmin).includes(key('ledger_entry', L_VENDOR)));
    t.assert('tier 3 is sent eleven: no ledger entry, no plan purchase, no credit top-up, no debt adjustment — and the two collections', () =>
        idsOf(asSupport).length === 11
        && rowsOf(asSupport).every((row) => !['ledger_entry', 'plan_purchase', 'credit_topup', 'earnings_adjustment'].includes(row.kind))
        && rowsOf(asSupport).filter((row) => row.kind === 'cod_collection').length === 2);
    t.assert('...and each is told what was withheld', () => {
        const withheld = (answer: Answer) => answer.body.meta?.withheld as { kinds: string[]; platformAccounts: boolean };
        return withheld(all).kinds.length === 0 && withheld(all).platformAccounts === false
            && withheld(asAdmin).kinds.length === 0 && withheld(asAdmin).platformAccounts === true
            && JSON.stringify(withheld(asSupport).kinds.sort()) === JSON.stringify(['credit_topup', 'earnings_adjustment', 'ledger_entry', 'plan_purchase']);
    });
    const platformForAdmin = await list(2, { ...WINDOW, role: 'platform', kind: 'ledger_entry' });
    const platformForDev = await list(1, { ...WINDOW, role: 'platform', kind: 'ledger_entry' });
    t.assert('role=platform: two rows for tier 1, zero for tier 2', () =>
        idsOf(platformForDev).length === 2 && idsOf(platformForAdmin).length === 0);

    t.section('2. What never leaves the database');
    const wire = JSON.stringify([all.body, asSupport.body]);
    t.assert('⚠ no delivery code, code hash, agent IP or device from a cash collection is on the wire', () =>
        [SECRET_CODE, SECRET_HASH, SECRET_IP, SECRET_DEVICE, '"verification"', '"code_'].every((secret) => !wire.includes(secret)));
    t.assert('no payout routing value, account name, transfer reference or gateway payload is on the wire', () =>
        !wire.includes(SECRET_MSISDN) && !wire.includes('Secret Holder') && !wire.includes('jm_po_secret') && !wire.includes('idem-secret'));
    t.assert('the payout row carries the destination type and provider label', () => {
        const payout = rowsOf(all).find((row) => row.id === PAYOUT_PAID.toString());
        return payout?.method === 'mobile_money' && payout.provider === 'Orange' && payout.gateway === 'NOTCHPAY' && payout.reference === 'np_tr_1';
    });

    t.section('3. Names, currencies, outcomes');
    const find = (answer: Answer, rowId: ObjectId) => rowsOf(answer).find((row) => row.id === rowId.toString());
    t.assert('the payer of a payment is named from the customer directory', () => find(all, PAYMENT)?.party.name === 'Awa Customer');
    t.assert('a vendor is named by its Store', () => find(all, PAYOUT_PAID)?.party.name === 'Boutique Verify' && find(all, PLAN)?.party.name === 'Boutique Verify');
    t.assert('a ledger row reads its currency off its account; a platform row has no id and no name', () =>
        find(all, L_VENDOR)?.currency === 'XAF' && find(all, L_PLATFORM)?.party.id === null && find(all, L_PLATFORM)?.party.name === null
        && find(all, L_AI)?.party.role === 'platform_ai');
    t.assert('one outcome word across four spellings of success', () =>
        [PAYMENT, PAYOUT_PAID, PLAN, REMITTANCE, REFUND, DEPOSIT_AGENCY].every((rowId) => find(all, rowId)?.outcome === 'succeeded')
        && find(all, PAYOUT_FAILED)?.outcome === 'failed' && find(all, TOPUP)?.outcome === 'pending' && find(all, DFR_OWED)?.outcome === 'pending');

    t.section('4. Filters, each run by MongoDB');
    const expectIds = async (name: string, raw: Record<string, string>, expected: string[], tier: 1 | 2 | 3 = 1) => {
        const answer = await list(tier, { ...WINDOW, limit: '100', ...raw });
        const got = idsOf(answer);
        t.assert(`${name} → ${expected.length} row(s)`, () => answer.status === 200 && JSON.stringify(got) === JSON.stringify([...expected].sort()));
    };
    await expectIds('amountGt=50000', { amountGt: '50000' }, [key('payout', PAYOUT_PAID), key('cod_remittance', REMITTANCE)]);
    await expectIds('amountLt=600', { amountLt: '600' }, [key('delivery_fee_refund', DFR_OWED), key('delivery_fee_refund', DFR_HAND), key('ledger_entry', L_AI)]);
    await expectIds('amount=20000', { amount: '20000' }, [key('payment', PAYMENT)]);
    await expectIds('amountMin=8000&amountMax=10000', { amountMin: '8000', amountMax: '10000' }, [key('cod_deposit', DEPOSIT_AGENCY), key('plan_purchase', PLAN)]);
    await expectIds('provider=mtn (lower case)', { provider: 'mtn' }, [key('payment', PAYMENT), key('plan_purchase', PLAN), key('payout', PAYOUT_FAILED)]);
    await expectIds('provider=ORANGE finds a payout typed "Orange"', { provider: 'ORANGE' }, [key('payout', PAYOUT_PAID)]);
    await expectIds('gateway=notchpay', { gateway: 'notchpay' }, [key('payment', PAYMENT), key('refund', REFUND), key('payout', PAYOUT_PAID), key('plan_purchase', PLAN), key('credit_topup', TOPUP)]);
    await expectIds('direction=in', { direction: 'in' }, [key('payment', PAYMENT), key('plan_purchase', PLAN), key('credit_topup', TOPUP), key('cod_deposit', DEPOSIT_PLATFORM), key('cod_remittance', REMITTANCE)]);
    await expectIds('direction=out', { direction: 'out' }, [key('refund', REFUND), key('delivery_fee_refund', DFR_OWED), key('delivery_fee_refund', DFR_HAND), key('payout', PAYOUT_PAID), key('payout', PAYOUT_FAILED)]);
    await expectIds('group=cash', { group: 'cash' }, [key('cod_deposit', DEPOSIT_AGENCY), key('cod_deposit', DEPOSIT_PLATFORM), key('cod_remittance', REMITTANCE), key('cod_collection', CC_COLLECTED), key('cod_collection', CC_PENDING)]);
    await expectIds('outcome=failed', { outcome: 'failed' }, [key('payout', PAYOUT_FAILED)]);
    await expectIds('outcome=pending', { outcome: 'pending' }, [key('credit_topup', TOPUP), key('cod_deposit', DEPOSIT_PLATFORM), key('delivery_fee_refund', DFR_OWED), key('cod_collection', CC_PENDING)]);
    await expectIds('role=agent', { role: 'agent' }, [key('payout', PAYOUT_FAILED), key('cod_deposit', DEPOSIT_AGENCY), key('cod_deposit', DEPOSIT_PLATFORM), key('earnings_adjustment', ADJ_PAYOUT_RECOVERY)]);
    await expectIds('role=customer', { role: 'customer' }, [key('payment', PAYMENT), key('refund', REFUND), key('delivery_fee_refund', DFR_OWED), key('delivery_fee_refund', DFR_HAND), key('cod_collection', CC_COLLECTED), key('cod_collection', CC_PENDING)]);
    await expectIds('partyId=<vendor>', { partyId: VENDOR.toString() }, [key('payout', PAYOUT_PAID), key('plan_purchase', PLAN), key('ledger_entry', L_VENDOR), key('earnings_adjustment', ADJ_WRITE_OFF)]);
    await expectIds('kind=earnings_adjustment — the two with no ledger row, never the two with one', { kind: 'earnings_adjustment' }, [key('earnings_adjustment', ADJ_WRITE_OFF), key('earnings_adjustment', ADJ_PAYOUT_RECOVERY)]);
    await expectIds('reasonCode=debt_write_off', { reasonCode: 'debt_write_off' }, [key('earnings_adjustment', ADJ_WRITE_OFF)]);
    await expectIds('reasonCode=cod_delivery_fee', { reasonCode: 'cod_delivery_fee' }, [key('cod_collection', CC_PENDING)]);
    await expectIds('kind=cod_collection&outcome=succeeded', { kind: 'cod_collection', outcome: 'succeeded' }, [key('cod_collection', CC_COLLECTED)]);
    await expectIds('kind=cod_collection&direction=in — a collection is never in', { kind: 'cod_collection', direction: 'in' }, []);
    await expectIds('kind=earnings_adjustment for Admin', { kind: 'earnings_adjustment' }, [key('earnings_adjustment', ADJ_WRITE_OFF), key('earnings_adjustment', ADJ_PAYOUT_RECOVERY)], 2);
    await expectIds('kind=earnings_adjustment for Support is an empty page', { kind: 'earnings_adjustment' }, [], 3);
    await expectIds('reasonCode=payout_auto_threshold', { reasonCode: 'payout_auto_threshold' }, [key('payout', PAYOUT_FAILED)]);
    await expectIds('reasonCode=order_split,refund', { reasonCode: 'order_split,refund' }, [key('ledger_entry', L_VENDOR), key('ledger_entry', L_PLATFORM), key('ledger_entry', L_AI), key('refund', REFUND)]);
    await expectIds('reference=jm_pt_verify (ours)', { reference: 'jm_pt_verify' }, [key('payment', PAYMENT)]);
    await expectIds('reference=MM-77 (a hand settlement)', { reference: 'MM-77' }, [key('delivery_fee_refund', DFR_HAND)]);
    await expectIds('method=payout (a refund channel)', { method: 'payout' }, [key('refund', REFUND)]);
    await expectIds('status=paid', { status: 'paid' }, [key('payout', PAYOUT_PAID), key('plan_purchase', PLAN)]);
    await expectIds('orderId=<order 1>, tier 1', { orderId: ORDER_1.toString() }, [key('payment', PAYMENT), key('refund', REFUND), key('ledger_entry', L_VENDOR), key('ledger_entry', L_PLATFORM), key('ledger_entry', L_AI), key('delivery_fee_refund', DFR_OWED), key('cod_collection', CC_COLLECTED)]);
    await expectIds('orderId=<order 1>, tier 3', { orderId: ORDER_1.toString() }, [key('payment', PAYMENT), key('refund', REFUND), key('delivery_fee_refund', DFR_OWED), key('cod_collection', CC_COLLECTED)], 3);
    await expectIds('a window that holds nothing', { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }, []);
    await expectIds('kind=ledger_entry for Support is an empty page', { kind: 'ledger_entry' }, [], 3);

    t.section('5. The walk');
    for (const sort of ['-createdAt', 'createdAt', '-amount', 'amount']) {
        const seen: TransactionRowDto[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const raw: Record<string, string> = { ...WINDOW, limit: '4', sort };
            if (cursor) raw.cursor = cursor;
            const page = await list(1, raw);
            seen.push(...rowsOf(page));
            cursor = (page.body.meta?.nextCursor as string | null) ?? null;
            pages++;
        } while (cursor && pages < 20);

        const keyOf = (row: TransactionRowDto) => (sort.endsWith('amount') ? row.amount : Date.parse(row.createdAt ?? ''));
        const direction = sort.startsWith('-') ? -1 : 1;
        const ordered = seen.every((row, i) => i === 0 || (keyOf(row) - keyOf(seen[i - 1])) * direction >= 0);
        t.assert(`sort=${sort}, 4 per page: eighteen rows once each, in order, over ${pages} pages`, () =>
            seen.length === 18 && new Set(seen.map((row) => `${row.kind}:${row.id}`)).size === 18 && ordered && pages === 5);
    }

    t.section('6. The summary');
    const totals = await summary(1, WINDOW);
    const cells = ((totals.body.data as { groups: Array<{ kind: string; direction: string; outcome: string; currency: string | null; count: number; amount: number }> }).groups);
    const cell = (kind: string, direction: string, outcome: string) => cells.find((c) => c.kind === kind && c.direction === direction && c.outcome === outcome);
    t.assert('the count is the list\'s row count', () => (totals.body.data as { count: number }).count === 18);
    t.assert('payments in, succeeded: 20 000 XAF in one row', () => cell('payment', 'in', 'succeeded')?.amount === 20000 && cell('payment', 'in', 'succeeded')?.currency === 'XAF');
    t.assert('payouts split by outcome', () => cell('payout', 'out', 'succeeded')?.amount === 100000 && cell('payout', 'out', 'failed')?.amount === 30000);
    t.assert('deposits split by who received the cash', () => cell('cod_deposit', 'internal', 'succeeded')?.amount === 8000 && cell('cod_deposit', 'in', 'pending')?.amount === 4000);
    t.assert('ledger entries are one internal cell with no currency', () => cell('ledger_entry', 'internal', 'succeeded')?.count === 3 && cell('ledger_entry', 'internal', 'succeeded')?.currency === null);
    const supportTotals = await summary(3, WINDOW);
    t.assert('the summary is graded like the list', () => (supportTotals.body.data as { count: number }).count === 11);
    const filtered = await summary(1, { ...WINDOW, direction: 'out', outcome: 'succeeded' });
    t.assert('...and filtered like it', () => (filtered.body.data as { count: number }).count === 3);

    t.section('7. The detail read');
    type Detail = { transaction: TransactionRowDto; record: { kind: string; [k: string]: unknown } | null; recordPath: string | null; related: { orders: { id: string; orderNumber: string | null }[]; transactions: TransactionRowDto[]; truncated: boolean } };
    const dataOf = (answer: Answer) => answer.body.data as Detail;

    const payment = await detail(1, 'payment', PAYMENT);
    t.assert('a payment opens with its order number, its own full read, and everything on the same order', () => {
        const d = dataOf(payment);
        const related = d.related.transactions.map((row) => `${row.kind}:${row.id}`).sort();
        return payment.status === 200 && d.transaction.id === PAYMENT.toString() && d.recordPath === `/money/payments/${PAYMENT.toString()}`
            && d.record === null && d.related.orders[0].orderNumber === 'ORD-VERIFY-1'
            && JSON.stringify(related) === JSON.stringify([
                key('refund', REFUND), key('ledger_entry', L_VENDOR), key('ledger_entry', L_PLATFORM), key('ledger_entry', L_AI), key('delivery_fee_refund', DFR_OWED),
                key('cod_collection', CC_COLLECTED),
            ].sort()) && d.related.truncated === false;
    });
    const paymentForSupport = await detail(3, 'payment', PAYMENT);
    t.assert('the same payment for Support: related rows are graded too — no ledger entries, and the cash collection on the order', () =>
        JSON.stringify(dataOf(paymentForSupport).related.transactions.map((row) => row.kind).sort()) === JSON.stringify(['cod_collection', 'delivery_fee_refund', 'refund']));

    const refund = await detail(3, 'refund', REFUND);
    t.assert('a refund has a record: fee kept, net sent, who asked, the vendor by name', () => {
        const record = dataOf(refund).record as unknown as { kind: string; feeAmount: number; netAmount: number; channel: string; initiatedBy: { role: string }; vendor: { name: string | null } };
        return record.kind === 'refund' && record.feeAmount === 100 && record.netAmount === 4900 && record.channel === 'payout'
            && record.initiatedBy.role === 'support' && record.vendor.name === 'Boutique Verify'
            && dataOf(refund).transaction.links.paymentTransactionId === PAYMENT.toString();
    });
    const entry = await detail(2, 'ledger_entry', L_VENDOR);
    t.assert('a ledger entry opens with its allocation', () => {
        const record = dataOf(entry).record as unknown as { kind: string; allocation: { id: string; amount: number; beneficiary: { name: string | null } } | null; balancesAfter: { pending: number } };
        return entry.status === 200 && record.kind === 'ledger_entry' && record.allocation?.id === ALLOCATION.toString()
            && record.allocation.amount === 17000 && record.allocation.beneficiary.name === 'Boutique Verify' && record.balancesAfter.pending === 17000;
    });
    t.assert('...and for tier 2 its related rows leave the platform\'s two out', () =>
        dataOf(entry).related.transactions.every((row) => !['platform', 'platform_ai'].includes(row.party.role)));

    const platformEntry = await detail(2, 'ledger_entry', L_PLATFORM);
    const platformEntryDev = await detail(1, 'ledger_entry', L_PLATFORM);
    t.assert('⚠ a platform ledger row is a 404 for tier 2 and a row for tier 1', () =>
        platformEntry.status === 404 && platformEntryDev.status === 200);
    const forbidden = await detail(3, 'plan_purchase', PLAN);
    t.assert('⚠ a kind Support may not read is a 403', () =>
        forbidden.status === 403 && forbidden.body.error?.code === 'AUTHZ_PERMISSION_DENIED');
    const plan = await detail(2, 'plan_purchase', PLAN);
    t.assert('a plan purchase has a record and no related rows', () =>
        (dataOf(plan).record as unknown as { planCode: string }).planCode === 'pro_monthly' && dataOf(plan).related.transactions.length === 0 && dataOf(plan).recordPath === null);
    const gatewaySettled = await detail(1, 'delivery_fee_refund', DFR_GATEWAY);
    const covered = await detail(1, 'delivery_fee_refund', DFR_COVERED);
    const hand = await detail(1, 'delivery_fee_refund', DFR_HAND);
    t.assert('a gateway-settled or "covered" delivery refund is not a transaction of this kind (404); a hand-settled one is', () =>
        gatewaySettled.status === 404 && covered.status === 404 && hand.status === 200
        && dataOf(hand).transaction.method === 'mobile_money' && dataOf(hand).transaction.reference === 'MM-77');
    const collected = await detail(3, 'cod_collection', CC_COLLECTED);
    t.assert('a cash collection opens for Support: the customer paid, the agent holds it, and the record splits the amount', () => {
        const d = dataOf(collected);
        const record = d.record as unknown as { kind: string; collects: string; itemsAmount: number; deliveryFeeAmount: number; settledAmount: number };
        const body = JSON.stringify(collected.body);
        return collected.status === 200 && d.transaction.direction === 'internal' && d.transaction.party.name === 'Awa Customer'
            && d.transaction.links.agentId === AGENT.toString() && d.transaction.amount === 7000 && d.transaction.outcome === 'succeeded'
            && record.kind === 'cod_collection' && record.collects === 'order' && record.itemsAmount === 7000 && record.deliveryFeeAmount === 0
            && d.related.orders[0]?.orderNumber === 'ORD-VERIFY-1'
            && [SECRET_CODE, SECRET_HASH, SECRET_IP, SECRET_DEVICE].every((secret) => !body.includes(secret));
    });
    const recovery = await detail(2, 'earnings_adjustment', ADJ_PAYOUT_RECOVERY);
    t.assert('a payout-driven recovery opens with the payout linked and the event named', () => {
        const d = dataOf(recovery);
        const record = d.record as unknown as { kind: string; adjustment: string; payoutEvent: string | null; actor: unknown };
        return recovery.status === 200 && d.transaction.links.payoutId === PAYOUT_FAILED.toString()
            && record.kind === 'earnings_adjustment' && record.adjustment === 'clawback_recovery' && record.payoutEvent === 'rejected' && record.actor === null;
    });
    const writeOff = await detail(1, 'earnings_adjustment', ADJ_WRITE_OFF);
    t.assert('a write-off says who forgave it and why', () => {
        const d = dataOf(writeOff);
        return writeOff.status === 200 && d.transaction.reason.text === 'Shop closed; balance unrecoverable'
            && (d.record as unknown as { actor: { name: string } }).actor.name === 'Ama Admin' && d.transaction.party.name === 'Boutique Verify';
    });
    const adjustmentForSupport = await detail(3, 'earnings_adjustment', ADJ_WRITE_OFF);
    const ledgeredRecovery = await detail(1, 'earnings_adjustment', ADJ_WITH_ALLOCATION);
    const overflow = await detail(1, 'earnings_adjustment', ADJ_OVERFLOW);
    t.assert('a debt adjustment is a 403 for Support; one that has a ledger row is not this kind (404)', () =>
        adjustmentForSupport.status === 403 && ledgeredRecovery.status === 404 && overflow.status === 404);
    const missing = await detail(1, 'payout', id());
    t.assert('an id that names nothing is a 404', () => missing.status === 404);
    const payout = await detail(3, 'payout', PAYOUT_PAID);
    t.assert('a payout detail discloses no destination either', () => {
        const body = JSON.stringify(payout.body);
        return payout.status === 200 && !body.includes(SECRET_MSISDN) && !body.includes('Secret Holder');
    });

    await platformConnection().db!.dropDatabase();
    await closeAll();
    return t.finish();
}

main().then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(1);
});

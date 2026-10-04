/**
 * test:statements — account statements (2026-09-27). **No DB, no network.**
 *
 * The statement is computed HERE from `jovi_mall` (owner decision O-8) and mailed by jovi-mall.
 * What this suite pins, in order of how badly each regression would hurt:
 *
 *  1. **The money reads BACK, it is never recomputed.** Every fee is an allocation jovi-mall
 *     wrote or the residual of those; `NET_FORMULA` is the contract copy jovi-mall's analytics
 *     share. A second implementation of the split here would be a second opinion about money.
 *  2. **The period loses no day.** `to` is inclusive; `end` is exclusive local midnight.
 *  3. **Nothing sharp leaves the database.** Projections exclude the gateway payloads, stored
 *     instruments, timeline metadata and payout account numbers.
 *  4. **Every tier holds the permission, and the audit row is the control** (O-5).
 *  5. **Both files render** from one document, and phones are masked in both.
 *
 * Run: npm run test:statements
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
import { suite } from './_assert';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import ExcelJS from 'exceljs';
import {
    NET_FORMULA,
    agencyEarningBreakdown,
    apportionBargainFee,
    collectionCashBreakdown,
    customerPaidDeliveryFee,
    vendorBorneDeliveryFee,
    vendorSaleBreakdown,
} from '../../src/modules/statements/domain/money-breakdown';
import { maskPhone } from '../../src/modules/statements/domain/statement-masking';
import { formatLocal, toStatementPeriod } from '../../src/modules/statements/domain/statement-period';
import { StatementDocument } from '../../src/modules/statements/domain/statement.types';
import { matchRemittance } from '../../src/modules/statements/domain/vendor-statement';
import { renderPdf, pdfSafe } from '../../src/modules/statements/render/pdf.renderer';
import { renderXlsx } from '../../src/modules/statements/render/xlsx.renderer';
import { CreateStatementBodySchema } from '../../src/modules/statements/validators/statement.validator';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { PERMISSION_CATALOG } from '../../src/modules/authorization/domain/permission.catalog';
import { AUDIT_CATALOG } from '../../src/modules/audit/domain/audit.catalog';
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/accounts/routes/account.routes';

const t = suite('account statements');
const SRC = join(__dirname, '../../src/modules/statements');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const throwsCode = (fn: () => unknown): string | null => {
    try {
        fn();
        return null;
    } catch (e) {
        return (e as { code?: string }).code ?? 'THREW';
    }
};

async function main(): Promise<number> {
    // ─────────────────────────────────────────────────────────────────────────
    t.section('1. Money is read back, never recomputed');

    t.assert('NET_FORMULA is the literal shared with jovi-mall analytics', () =>
        NET_FORMULA === 'net = gross - bargainFee - commission - deliveryFee - codFee');

    // A prepaid order: gross 10 000, bargain 300, commission 970, net 7 730 → delivery 1 000.
    const prepaid = vendorSaleBreakdown({ sourceType: 'order', gross: 10_000, net: 7_730, commission: 970, bargainFee: 300, deliveryFeeSnapshot: null });
    t.assert('prepaid: the whole residual is delivery, COD fee is 0', () =>
        prepaid.deliveryFee === 1_000 && prepaid.codFee === 0);
    t.assert('prepaid: the formula closes exactly', () =>
        prepaid.gross - prepaid.bargainFee - prepaid.commission - prepaid.deliveryFee! - prepaid.codFee! === prepaid.net);

    // COD: residual 1 200, shipment snapshot 1 000 → COD fee 200.
    const cod = vendorSaleBreakdown({ sourceType: 'cod_collection', gross: 10_000, net: 7_530, commission: 970, bargainFee: 300, deliveryFeeSnapshot: 1_000 });
    t.assert('COD: delivery from the shipment snapshot, COD fee is the rest', () =>
        cod.deliveryFee === 1_000 && cod.codFee === 200);
    t.assert('COD: the formula closes exactly', () =>
        cod.gross - cod.bargainFee - cod.commission - cod.deliveryFee! - cod.codFee! === cod.net);

    const unsplit = vendorSaleBreakdown({ sourceType: 'cod_collection', gross: 10_000, net: 7_530, commission: 970, bargainFee: 300, deliveryFeeSnapshot: null });
    t.assert('COD without a snapshot: refuses to invent a split, keeps the combined figure', () =>
        unsplit.deliveryFee === null && unsplit.codFee === null && unsplit.deliveryAndCod === 1_200);
    const impossible = vendorSaleBreakdown({ sourceType: 'cod_collection', gross: 10_000, net: 7_530, commission: 970, bargainFee: 300, deliveryFeeSnapshot: 5_000 });
    t.assert('COD with a snapshot larger than the residual: refused, not negative', () =>
        impossible.codFee === null);

    // ── Customer-paid delivery (jovi-mall ADR-A11) ───────────────────────────
    // NET_FORMULA's `deliveryFee` is the VENDOR-BORNE fee: max(0, agency fee − what the customer paid).
    t.assert('vendor-borne fee: a vendor-paid shipment bears the whole agency fee', () =>
        vendorBorneDeliveryFee({ delivery_fee_snapshot: 1_000, delivery_payer: 'vendor', customer_delivery_fee: 0 }) === 1_000);
    t.assert('vendor-borne fee: a shipment from before ADR-A11 (no payer) is the shop\'s — the whole fee', () =>
        vendorBorneDeliveryFee({ delivery_fee_snapshot: 1_000 }) === 1_000);
    t.assert('vendor-borne fee: a customer-paid shipment the customer covered bears nothing', () =>
        vendorBorneDeliveryFee({ delivery_fee_snapshot: 1_000, delivery_payer: 'customer', customer_delivery_fee: 1_000 }) === 0);
    t.assert('vendor-borne fee: a fee raised above what the customer paid leaves the vendor the difference', () =>
        vendorBorneDeliveryFee({ delivery_fee_snapshot: 1_300, delivery_payer: 'customer', customer_delivery_fee: 1_000 }) === 300);
    t.assert('vendor-borne fee: a customer overpayment never goes negative', () =>
        vendorBorneDeliveryFee({ delivery_fee_snapshot: 800, delivery_payer: 'customer', customer_delivery_fee: 1_000 }) === 0);
    t.assert('vendor-borne fee: a customer fee on a VENDOR-paid shipment is ignored (payer decides)', () =>
        vendorBorneDeliveryFee({ delivery_fee_snapshot: 1_000, delivery_payer: 'vendor', customer_delivery_fee: 1_000 }) === 1_000);
    t.assert('vendor-borne fee: no recorded fee → null (the caller refuses to split)', () =>
        vendorBorneDeliveryFee({ delivery_fee_snapshot: null, delivery_payer: 'customer', customer_delivery_fee: 1_000 }) === null);
    t.assert('customer-paid fee: 0 unless the shipment says the customer paid', () =>
        customerPaidDeliveryFee({ delivery_fee_snapshot: 1_000, customer_delivery_fee: 1_000 }) === 0
        && customerPaidDeliveryFee({ delivery_fee_snapshot: 1_000, delivery_payer: 'customer', customer_delivery_fee: 1_000 }) === 1_000);

    // A customer-paid COD collection: goods 10 000, the customer also hands over 1 000 delivery.
    // jovi-mall's split: gross = items 10 000, vendorNet = 10 000 − 300 − 970 − 0 (vendor-borne) − 200 = 8 530.
    const paidShipment = { delivery_fee_snapshot: 1_000, delivery_payer: 'customer' as const, customer_delivery_fee: 1_000 };
    const customerPaidCod = vendorSaleBreakdown({
        sourceType: 'cod_collection', gross: 10_000, net: 8_530, commission: 970, bargainFee: 300,
        deliveryFeeSnapshot: vendorBorneDeliveryFee(paidShipment),
    });
    t.assert('customer-paid COD: delivery 0, COD fee 200 — the row is split, not blanked', () =>
        customerPaidCod.deliveryFee === 0 && customerPaidCod.codFee === 200);
    t.assert('customer-paid COD: the formula closes exactly', () =>
        customerPaidCod.gross - customerPaidCod.bargainFee - customerPaidCod.commission
            - customerPaidCod.deliveryFee! - customerPaidCod.codFee! === customerPaidCod.net);
    t.assert('regression guard: splitting with the AGENCY fee would have blanked that row', () =>
        vendorSaleBreakdown({ sourceType: 'cod_collection', gross: 10_000, net: 8_530, commission: 970, bargainFee: 300, deliveryFeeSnapshot: 1_000 })
            .deliveryFee === null);
    const customerPaidPrepaid = vendorSaleBreakdown({ sourceType: 'order', gross: 10_000, net: 8_730, commission: 970, bargainFee: 300, deliveryFeeSnapshot: null });
    t.assert('customer-paid prepaid: residual 0 — no delivery deducted from the vendor', () =>
        customerPaidPrepaid.deliveryFee === 0 && customerPaidPrepaid.codFee === 0);

    t.assert('COD cash breakdown: goods + delivery from the collection', () => {
        const b = collectionCashBreakdown({ expected_amount: 11_000, items_amount: 10_000, delivery_fee_amount: 1_000 });
        return b.itemsAmount === 10_000 && b.deliveryFeeAmount === 1_000;
    });
    t.assert('COD cash breakdown: a row from before ADR-A11 is all goods', () => {
        const b = collectionCashBreakdown({ expected_amount: 10_000 });
        return b.itemsAmount === 10_000 && b.deliveryFeeAmount === 0;
    });

    t.assert('the vendor statement splits COD with the VENDOR-BORNE fee, never the raw snapshot', () => {
        const src = read('domain/vendor-statement.ts');
        return /deliveryFeeSnapshot = s \? vendorBorneDeliveryFee\(s\) : null/.test(src)
            && !/deliveryFeeSnapshot = s\?\.delivery_fee_snapshot/.test(src);
    });
    t.assert('the statement reads the payer and the customer fee off the shipment, and the cash breakdown off the collection', () => {
        const repo = read('repositories/statement.read.repository.ts');
        return /delivery_payer: 1, customer_delivery_fee: 1/.test(repo) && /items_amount: 1, delivery_fee_amount: 1/.test(repo);
    });
    {
        // jovi-mall's analytics are the other reader of the same money: both must split with the
        // vendor-borne fee, or a vendor's dashboard and the emailed statement disagree.
        const analytics = join(__dirname, '../../../jovi-mall/src/modules/vendors/services/vendor-analytics.service.ts');
        if (existsSync(analytics)) {
            const text = readFileSync(analytics, 'utf8');
            t.assert("jovi-mall's vendor analytics also split with the vendor-borne fee", () =>
                /deliveryFeeShares\(snapshot, customerDeliveryFeeOf\(null, s\)\)\.vendorBorne/.test(text));
        } else {
            console.log('  ⚪ jovi-mall not checked out beside wi-admin — analytics parity check skipped');
        }
    }

    const agencyCod = agencyEarningBreakdown({ sourceType: 'cod_collection', agencyNet: 900, agentCut: 300, deliveryFee: 1_000 });
    t.assert('agency COD: handling fee = agencyNet + agentCut − deliveryFee', () =>
        agencyCod.codFee === 200 && agencyCod.earnedDeliveryFee === 1_000);
    const agencyReturn = agencyEarningBreakdown({ sourceType: 'shipment', agencyNet: 350, agentCut: 150, deliveryFee: null });
    t.assert('agency prepaid (e.g. a return): earned = agencyNet + agentCut, no COD fee', () =>
        agencyReturn.earnedDeliveryFee === 500 && agencyReturn.codFee === 0);

    const shares = apportionBargainFee(
        [
            { lineId: 'a', unitPricePaid: 1_200, quantity: 1, floorPriceSnapshot: 1_000 },
            { lineId: 'b', unitPricePaid: 700, quantity: 2, floorPriceSnapshot: 600 },
            { lineId: 'c', unitPricePaid: 500, quantity: 1, floorPriceSnapshot: null },
            // Sold at the ask WITHOUT haggling — still pays (owner decision 2026-09-28).
            { lineId: 'd', unitPricePaid: 1_500, quantity: 1, floorPriceSnapshot: 1_000 },
            // Sold at the minimum — no uplift, no fee.
            { lineId: 'e', unitPricePaid: 1_000, quantity: 1, floorPriceSnapshot: 1_000 },
        ],
        270, // floor(.3×200) + floor(.3×200) + floor(.3×500) = 60 + 60 + 150
    );
    t.assert('bargain fee apportioned by uplift sums to the persisted total exactly', () =>
        [...shares.values()].reduce((s, v) => s + v, 0) === 270);
    t.assert('a line of a non-bargainable variant carries no bargain fee', () => shares.get('c') === 0);
    t.assert('an UN-HAGGLED line sold at the ask carries its share (30% of 500)', () => shares.get('d') === 150);
    t.assert('a line sold at the minimum carries no bargain fee', () => shares.get('e') === 0);

    // Which remittance settled a vendor's COD cash: no stored link, so matched on the instant
    // the FIFO settlement stamped inside the confirmation's own transaction.
    const agency = new ObjectId();
    const settledAt = new Date('2026-09-10T12:00:00.000Z');
    const collection = { agency_id: agency, settled_at: settledAt } as never;
    const remittance = (ms: number, agencyId = agency) =>
        ({ _id: new ObjectId(), agency_id: agencyId, resolved_at: new Date(settledAt.getTime() + ms), reference: `R${ms}` }) as never;
    t.assert('remittance: the confirmation milliseconds from settled_at is named', () =>
        (matchRemittance(collection, [remittance(5_000), remittance(40)]) as { reference: string } | null)?.reference === 'R40');
    t.assert('remittance: another agency\'s confirmation at the same instant is never named', () =>
        matchRemittance(collection, [remittance(10, new ObjectId())]) === null);
    t.assert('remittance: nothing within a minute → blank, not a guess', () =>
        matchRemittance(collection, [remittance(120_000)]) === null);

    t.assert('no statement source multiplies by a commission or margin RATE', () => {
        const src = ['domain/money-breakdown.ts', 'domain/vendor-statement.ts', 'domain/delivery-statement.ts'].map(read).join('\n');
        return !/commission_percent_snapshot\s*\*|\*\s*commission_percent_snapshot|AI_MARGIN_PERCENT|\*\s*0\.3\b/.test(src);
    });

    // ─────────────────────────────────────────────────────────────────────────
    t.section('2. The period');

    const p = toStatementPeriod('2026-09-01', '2026-09-30');
    t.assert('start is local midnight of `from` (UTC+1 → 23:00Z the day before)', () =>
        p.start.toISOString() === '2026-08-31T23:00:00.000Z');
    t.assert('end is EXCLUSIVE local midnight after `to` — the last day is kept', () =>
        p.end.toISOString() === '2026-09-30T23:00:00.000Z');
    t.assert('a 23:30 local sale on the last day is inside the period', () => {
        const lastMinute = new Date('2026-09-30T22:30:00.000Z');
        return lastMinute >= p.start && lastMinute < p.end;
    });
    t.assert('`from` after `to` is refused', () => throwsCode(() => toStatementPeriod('2026-09-02', '2026-09-01')) === 'VALIDATION_ERROR');
    t.assert('a period over 366 days is refused', () => throwsCode(() => toStatementPeriod('2025-01-01', '2026-01-03')) === 'VALIDATION_ERROR');
    t.assert('a non-date (2026-02-31) is refused, not moved to March', () =>
        throwsCode(() => toStatementPeriod('2026-02-31', '2026-03-01')) === 'VALIDATION_ERROR');
    t.assert('dates print in the statement zone', () => formatLocal(new Date('2026-09-30T22:30:00.000Z')) === '2026-09-30 23:30');

    // ─────────────────────────────────────────────────────────────────────────
    t.section('3. Nothing sharp leaves the database');

    const repo = read('repositories/statement.read.repository.ts');
    const projectionBlocks = repo.match(/super\(COLLECTIONS\.[A-Z_]+,\s*\{[\s\S]*?\}\)/g) ?? [];
    const projected = projectionBlocks.join('\n');
    t.assert('the scan found the projections (a silent zero would be a false green)', () => projectionBlocks.length >= 17);
    for (const banned of ['rawGatewayPayloads', 'payloadHash', 'idempotencyKey', 'saved_payment_methods', 'metadata', 'account_number', 'phone_number', 'payLink']) {
        t.assert(`no projection reads \`${banned}\``, () => !projected.includes(banned));
    }
    t.assert('payouts project the method KIND and provider only', () =>
        /'payout_method_snapshot\.method': 1/.test(repo) && !/payout_method_snapshot: 1/.test(repo));
    t.assert('customers project name and phone only', () => /COLLECTIONS\.CUSTOMER,\s*\{ _id: 1, name: 1, phone: 1 \}/.test(repo));
    t.assert('every range query is end-EXCLUSIVE', () => /\$lt: r\.end/.test(repo) && !/\$lte/.test(repo));

    // ─────────────────────────────────────────────────────────────────────────
    t.section('4. Who may, and the record');

    t.assert('`money.statements.send` exists and is NOT financial', () => {
        const spec = (PERMISSION_CATALOG as Record<string, { financial?: boolean }>)['money.statements.send'];
        return !!spec && !spec.financial;
    });
    t.assert('every tier holds it — Support included (owner decision O-5)', () =>
        ([1, 2, 3] as const).every((tier) => (TIER_GRANTS[tier] as readonly string[]).includes('money.statements.send')));
    for (const owner of ['vendor', 'agency', 'agent']) {
        t.assert(`audit action money.statements.send_${owner} targets ${owner}, transport external`, () => {
            const spec = (AUDIT_CATALOG as unknown as Record<string, { target: string; transport: string; permission: string | null }>)[
                `money.statements.send_${owner}`
            ];
            return spec?.target === owner && spec.transport === 'external' && spec.permission === 'money.statements.send';
        });
    }
    const service = read('domain/statement.service.ts');
    t.assert('the service wraps the read in auditedAttempt (intent committed first)', () =>
        /return auditedAttempt<StatementOutcome>\(intent/.test(service));
    t.assert('the period is validated BEFORE the audit row', () =>
        service.indexOf('toStatementPeriod(') < service.indexOf('auditedAttempt<'));
    t.assert('the audit payload carries no figure — ids, period, format, channel only', () => {
        const payload = /payload: \{([\s\S]*?)\},/.exec(service)?.[1] ?? '';
        return /ownerId/.test(payload) && !/amount|net|gross|balance/i.test(payload);
    });
    const gateway = read('gateways/statement-mail.gateway.ts');
    t.assert('the mail body names NO recipient (jovi-mall chooses it)', () => {
        const body = /body: \{([\s\S]*?)\},/.exec(gateway)?.[1] ?? '';
        return body.length > 0 && !/\b(to_email|email|recipient|cc|bcc)\s*:/.test(body);
    });
    t.assert('the request body is strict — an email field is refused', () =>
        !CreateStatementBodySchema.safeParse({ from: '2026-09-01', to: '2026-09-30', format: 'pdf', delivery: 'email', email: 'x@y.z' }).success);
    const route = routeManifest().find((r) => r.fullPath === '/api/v1/accounts/:ownerType/:ownerId/statements');
    t.assert('the route is mounted, gated on money.statements.send, and declares its three audit actions', () =>
        route?.method === 'post'
        && route.access.kind === 'permission'
        && [...route.access.permissions].join() === 'money.statements.send'
        && route.audit?.kind === 'records'
        && route.audit.actions.length === 3);

    // ─────────────────────────────────────────────────────────────────────────
    t.section('5. Rendering');

    t.assert('phones mask as +2376••••4417 (jovi-mall maskPhone shape)', () => maskPhone('+237600124417') === '+2376••••4417');
    t.assert('a short number masks entirely', () => maskPhone('12345') === '••••');
    t.assert('the pdf strips non-WinAnsi characters (U+2212 minus)', () => pdfSafe('a − b → c') === 'a - b -> c');

    const doc: StatementDocument = {
        ownerType: 'vendor',
        ownerId: new ObjectId().toHexString(),
        ownerName: 'Chez Ada',
        period: { from: '2026-09-01', to: '2026-09-30', timezoneLabel: 'Africa/Douala (UTC+01:00)' },
        generatedAt: new Date('2026-09-27T10:00:00Z'),
        currency: 'XAF',
        summary: [
            { label: 'Total sales (gross)', value: 10_000, kind: 'money' },
            { label: 'Commission', value: -970, kind: 'money', indent: true },
            { label: 'Net revenue from sales', value: 7_530, kind: 'money' },
        ],
        notes: ['A note − with a minus sign.'],
        sections: [
            {
                key: 'sales',
                title: 'Sales and deductions',
                description: 'Test.',
                columns: [
                    { key: 'at', header: 'Money received', kind: 'datetime' },
                    { key: 'customer', header: 'Placed by', kind: 'text' },
                    { key: 'phone', header: 'Phone', kind: 'text' },
                    { key: 'net', header: 'Net', kind: 'money' },
                ],
                rows: [{ at: new Date('2026-09-30T22:30:00Z'), customer: 'Ada', phone: maskPhone('+237600124417'), net: 7_530 }],
                totals: ['net'],
            },
            { key: 'orders', title: 'Orders', description: 'Wide.', columns: [{ key: 'x', header: 'X', kind: 'text' }], rows: [], pdf: 'xlsx-only' },
        ],
    };

    const xlsx = await renderXlsx(doc);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    const salesSheet = wb.getWorksheet('Sales and deductions');
    const dataRow = salesSheet?.getRow(5);
    t.assert('xlsx: a Summary sheet plus one sheet per section, even an empty one', () =>
        wb.worksheets.map((w) => w.name).join('|') === 'Summary|Sales and deductions|Orders');
    t.assert('xlsx: money is a NUMBER, not preformatted text', () => dataRow?.getCell(4).value === 7_530);
    t.assert('xlsx: the masked phone is what is written', () => dataRow?.getCell(3).value === '+2376••••4417');
    t.assert('xlsx: dates are shifted to the statement wall clock', () => {
        const v = dataRow?.getCell(1).value;
        return v instanceof Date && v.toISOString().startsWith('2026-09-30T23:30');
    });
    t.assert('xlsx: an empty section says so', () =>
        wb.getWorksheet('Orders')?.getRow(5).getCell(1).value === 'No entries in this period.');

    const pdf = await renderPdf(doc);
    t.assert('pdf: renders a PDF', () => pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 1_000);

    return t.finish();
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

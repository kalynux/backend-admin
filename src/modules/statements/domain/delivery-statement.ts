import { ObjectId } from 'mongodb';
import {
    AllocationRow,
    Range,
    StatementAllocationRepository,
    StatementCashCollectionRepository,
    StatementDepositRepository,
    StatementOrderRepository,
    StatementRemittanceRepository,
    StatementReserveHoldRepository,
    StatementShipmentRepository,
} from '../repositories/statement.read.repository';
import { agencyEarningBreakdown, AgencyEarningBreakdown, collectionCashBreakdown } from './money-breakdown';
import { allocationStatusLabel, col, idOf, loadNames, sumOf } from './statement-common';
import { reversalLabel, reversalsFor } from './earnings-reversals';
import { StatementSection, SummaryLine } from './statement.types';

/**
 * The agency and agent statements — both are paid for DELIVERIES, so they share one reader.
 *
 * An agency's money per delivery is one allocation row (`agencyNet`), and the agent's is its
 * sibling (`agentCut`). jovi-mall writes both on the same source (`shipment` for prepaid,
 * `cod_collection` for COD), so each side can show the other's share of the same run —
 * which is exactly the question an agency and its agent argue about.
 */

const allocations = new StatementAllocationRepository();
const shipments = new StatementShipmentRepository();
const collections = new StatementCashCollectionRepository();
const orders = new StatementOrderRepository();
const deposits = new StatementDepositRepository();
const remittances = new StatementRemittanceRepository();
const reserves = new StatementReserveHoldRepository();

/** What a shipment is resolved from: an allocation, or a clawback line (which may name no source). */
type SourceRef = { source_type: string | null; source_id: ObjectId | null };

export interface DeliveryStatementParts {
    sections: StatementSection[];
    summary: SummaryLine[];
    notes: string[];
    currency: string | null;
}

export async function deliveryStatement(
    ownerType: 'agency' | 'agent',
    ownerId: string,
    range: Range,
): Promise<DeliveryStatementParts> {
    const field = ownerType === 'agency' ? 'agency_id' : 'agent_id';
    const [created, { reversals, writeOffs }, cashRows, depositRows, remittanceRows, reserveRows] = await Promise.all([
        allocations.createdFor(ownerType, ownerId, range),
        // From `earnings_adjustments` (REFUND-FLOW-PLAN § 6.1): partial claws included, a full one
        // counted once. A delivery share is clawed only by a lost dispute (C-1, C-3).
        reversalsFor(ownerType, ownerId, range),
        collections.collectedFor(field, ownerId, range),
        deposits.createdFor(field, ownerId, range),
        ownerType === 'agency' ? remittances.declaredFor(ownerId, range) : Promise.resolve([]),
        ownerType === 'agency' ? reserves.touchedFor(ownerId, range) : Promise.resolve([]),
    ]);

    const earnings = created.filter((a) => a.source_type === 'shipment' || a.source_type === 'cod_collection');
    const reversed: SourceRef[] = reversals.map((r) => ({ source_type: r.sourceType, source_id: r.sourceId }));
    const sourceCollections = await collections.byIds(
        [...earnings, ...reversed].filter((a) => a.source_type === 'cod_collection' && a.source_id).map((a) => a.source_id as ObjectId),
    );
    const collectionById = new Map([...sourceCollections, ...cashRows].map((c) => [idOf(c._id), c]));

    const shipmentIdOf = (a: SourceRef): ObjectId | null =>
        !a.source_id
            ? null
            : a.source_type === 'shipment'
              ? a.source_id
              : collectionById.get(idOf(a.source_id))?.shipment_id ?? null;

    const shipmentIds = [
        ...[...earnings, ...reversed].map(shipmentIdOf),
        ...cashRows.map((c) => c.shipment_id),
    ].filter((id): id is ObjectId => !!id);

    const [shipmentRows, siblings] = await Promise.all([
        shipments.byIds(shipmentIds),
        allocations.forSources(earnings.map((a) => ({ type: a.source_type, id: a.source_id }))),
    ]);
    const shipmentById = new Map(shipmentRows.map((s) => [idOf(s._id), s]));
    const orderRows = await orders.byIds(shipmentRows.map((s) => s.order_id));
    const orderById = new Map(orderRows.map((o) => [idOf(o._id), o]));

    const names = await loadNames({
        vendors: orderRows.map((o) => o.vendor_id),
        agencies: [...shipmentRows.map((s) => s.agency_id), ...depositRows.map((d) => d.agency_id)],
        agents: [
            ...shipmentRows.map((s) => s.agent_id).filter((id): id is ObjectId => !!id),
            ...cashRows.map((c) => c.agent_id),
            ...depositRows.map((d) => d.agent_id),
        ],
    });

    const shipmentOf = (a: AllocationRow) => {
        const id = shipmentIdOf(a);
        return id ? shipmentById.get(idOf(id)) ?? null : null;
    };
    const orderOfShipment = (id: ObjectId | null | undefined) => {
        const s = id ? shipmentById.get(idOf(id)) : undefined;
        return s ? orderById.get(idOf(s.order_id)) ?? null : null;
    };

    // ── Breakdown per earning ─────────────────────────────────────────────────
    const breakdowns = new Map<string, AgencyEarningBreakdown>();
    for (const a of earnings) {
        const sib = siblings.filter((s) => s.source_type === a.source_type && s.source_id.equals(a.source_id));
        const agencyRow = sib.find((s) => s.beneficiary_type === 'agency');
        const agentRow = sib.find((s) => s.beneficiary_type === 'agent');
        breakdowns.set(
            idOf(a._id),
            agencyEarningBreakdown({
                sourceType: a.source_type as 'shipment' | 'cod_collection',
                agencyNet: agencyRow?.amount ?? 0,
                agentCut: agentRow?.amount ?? 0,
                deliveryFee: a.source_type === 'cod_collection' ? shipmentOf(a)?.delivery_fee_snapshot ?? null : null,
            }),
        );
    }
    const bd = (a: AllocationRow) => breakdowns.get(idOf(a._id))!;

    const earningsSection: StatementSection = {
        key: 'earnings',
        title: ownerType === 'agency' ? 'Delivery earnings' : 'Your delivery earnings',
        description:
            ownerType === 'agency'
                ? 'One row per delivery credited in this period. The agency keeps the delivery fee earned minus the ' +
                  "agent's share, plus the whole COD handling fee on cash-on-delivery runs. \"Fee paid by\" says whether the " +
                  "shop or the customer paid the delivery fee; the agency earns the same either way."
                : "One row per delivery credited in this period. Your share comes out of the delivery fee earned, under " +
                  "your contract's fee split. The COD handling fee stays with the agency. \"Fee paid by\" says whether the " +
                  'shop or the customer paid the delivery fee; your share is the same either way.',
        columns: [
            col.at('at', 'Credited'),
            col.text('order', 'Order', 18),
            col.text('tracking', 'Tracking #', 16),
            col.text('vendor', 'Vendor', 18),
            col.text(ownerType === 'agency' ? 'agent' : 'agency', ownerType === 'agency' ? 'Agent' : 'Agency', 18),
            col.text('kind', 'Payment', 14),
            col.text('outcome', 'Outcome', 12),
            col.text('feePayer', 'Fee paid by', 10),
            col.money('fee', 'Delivery fee earned'),
            col.money('codFee', 'COD fee'),
            col.money('agentCut', "Agent's share"),
            col.money('agencyNet', 'Agency net'),
            col.text('status', 'Status', 20),
            col.at('releasedAt', 'Available since'),
        ],
        rows: earnings.map((a) => {
            const s = shipmentOf(a);
            const o = s ? orderById.get(idOf(s.order_id)) : undefined;
            const b = bd(a);
            return {
                at: a.created_at,
                order: o?.order_number ?? null,
                tracking: s?.tracking_number ?? null,
                vendor: o ? names.vendor(o.vendor_id) : null,
                agent: s ? names.agent(s.agent_id) : null,
                agency: s ? names.agency(s.agency_id) : null,
                kind: a.source_type === 'shipment' ? 'Prepaid' : 'Cash on delivery',
                outcome: s?.status ?? null,
                // `null`/absent predates customer-paid delivery (jovi-mall ADR-A11) and IS the shop.
                feePayer: s ? (s.delivery_payer === 'customer' ? 'Customer' : 'Shop') : null,
                fee: b.earnedDeliveryFee,
                codFee: b.codFee,
                agentCut: b.agentCut,
                agencyNet: b.agencyNet,
                status: allocationStatusLabel(a),
                releasedAt: a.released_at ?? null,
            };
        }),
        totals: ['fee', 'codFee', 'agentCut', 'agencyNet'],
    };

    const cashSection: StatementSection = {
        key: 'cod_collections',
        title: 'Cash collected on delivery',
        description:
            ownerType === 'agency'
                ? 'Cash your agents collected from customers in this period, and how much of it has been settled to the platform. ' +
                  '"Delivery fee" is the part the customer paid for delivery in cash, where the shop made the customer pay it.'
                : 'Cash you collected from customers in this period, and how much of it has been settled to the platform. ' +
                  '"Delivery fee" is the part the customer paid for delivery in cash, where the shop made the customer pay it.',
        columns: [
            col.at('collectedAt', 'Collected'),
            col.text('order', 'Order', 18),
            col.text(ownerType === 'agency' ? 'agent' : 'vendor', ownerType === 'agency' ? 'Agent' : 'Vendor', 18),
            col.money('goods', 'Goods'),
            col.money('deliveryFee', 'Delivery fee'),
            col.money('amount', 'Amount'),
            col.money('settled', 'Settled so far'),
            col.at('settledAt', 'Fully settled'),
        ],
        rows: cashRows.map((c) => {
            const o = orderById.get(idOf(c.order_id)) ?? orderOfShipment(c.shipment_id);
            const cash = collectionCashBreakdown(c);
            return {
                collectedAt: c.collected_at ?? null,
                order: o?.order_number ?? null,
                agent: names.agent(c.agent_id),
                vendor: o ? names.vendor(o.vendor_id) : null,
                goods: cash.itemsAmount,
                deliveryFee: cash.deliveryFeeAmount,
                amount: c.expected_amount,
                settled: c.settled_amount,
                settledAt: c.settled_at ?? null,
            };
        }),
        totals: ['goods', 'deliveryFee', 'amount', 'settled'],
    };

    const depositSection: StatementSection = {
        key: 'deposits',
        title: ownerType === 'agency' ? 'Cash handed over by agents' : 'Cash you handed over',
        description: 'Agent cash handovers declared or recorded in this period, and whether they were confirmed.',
        columns: [
            col.at('at', 'Declared'),
            col.text(ownerType === 'agency' ? 'agent' : 'agency', ownerType === 'agency' ? 'Agent' : 'Agency', 18),
            col.money('amount', 'Amount'),
            col.text('recipient', 'Handed to', 10),
            col.text('status', 'Status', 10),
            col.text('recordedBy', 'Recorded by', 18),
            col.at('resolvedAt', 'Confirmed / rejected'),
            col.text('reference', 'Reference / reason', 22),
        ],
        rows: depositRows.map((d) => ({
            at: d.declared_at ?? d.created_at,
            agent: names.agent(d.agent_id),
            agency: names.agency(d.agency_id),
            amount: d.amount,
            recipient: d.recipient,
            status: d.status,
            recordedBy: d.recorded_by_name ?? d.recorded_by_source ?? null,
            resolvedAt: d.resolved_at ?? null,
            reference: d.reference ?? d.rejection_reason ?? null,
        })),
        totals: ['amount'],
    };

    const adjustmentsSection: StatementSection = {
        key: 'adjustments',
        title: 'Adjustments to your earnings',
        description:
            'Earnings taken back in this period — in full or in part — for example after a lost payment dispute. ' +
            '"Owed back" is the part your balance could not cover, recovered from your next earnings.',
        columns: [
            col.at('at', 'Date'),
            col.text('kind', 'Adjustment', 22),
            col.text('order', 'Order', 18),
            col.money('amount', 'Amount'),
            col.money('owed', 'Owed back'),
        ],
        rows: reversals.map((r) => ({
            at: r.at,
            kind: reversalLabel(r),
            order: orderOfShipment(shipmentIdOf({ source_type: r.sourceType, source_id: r.sourceId }))?.order_number ?? null,
            amount: -r.amount,
            owed: r.toDebt,
        })),
        totals: ['amount'],
    };

    const sections: StatementSection[] = [earningsSection, cashSection, depositSection];

    if (ownerType === 'agency') {
        sections.push(
            {
                key: 'remittances',
                title: 'Cash remitted to the platform',
                description: 'COD cash the agency declared as paid to the platform, and who confirmed it.',
                columns: [
                    col.at('declaredAt', 'Declared'),
                    col.money('amount', 'Amount'),
                    col.text('reference', 'Reference', 18),
                    col.text('status', 'Status', 10),
                    col.at('resolvedAt', 'Confirmed / rejected'),
                    col.text('resolvedBy', 'By', 18),
                    col.text('reason', 'Rejection reason', 22),
                ],
                rows: remittanceRows.map((r) => ({
                    declaredAt: r.declared_at,
                    amount: r.amount,
                    reference: r.reference ?? null,
                    status: r.status,
                    resolvedAt: r.resolved_at ?? null,
                    resolvedBy: r.resolved_by_name ?? r.resolved_by_source ?? null,
                    reason: r.rejection_reason ?? null,
                })),
                totals: ['amount'],
            },
            {
                key: 'reserve',
                title: 'COD reserve',
                description:
                    'A slice of released COD earnings the platform holds for a period as security against cash shortfalls, ' +
                    'then returns to your available balance.',
                columns: [
                    col.at('heldAt', 'Held'),
                    col.money('amount', 'Amount'),
                    col.at('releaseDue', 'Release due'),
                    col.at('releasedAt', 'Released'),
                    col.text('status', 'Status', 10),
                ],
                rows: reserveRows.map((r) => ({
                    heldAt: r.held_at,
                    amount: r.amount,
                    releaseDue: r.release_at,
                    releasedAt: r.released_at ?? null,
                    status: r.status,
                })),
                totals: ['amount'],
            },
        );
    }
    sections.push(adjustmentsSection);

    // ── Summary ────────────────────────────────────────────────────────────────
    const own = (a: AllocationRow) => a.amount;
    const earned = sumOf(earnings, own);
    const reversedTotal = sumOf(reversals, (r) => r.amount);
    const unsplit = earnings.filter((a) => bd(a).codFee === null).length;

    const summary: SummaryLine[] =
        ownerType === 'agency'
            ? [
                  { label: 'Delivery fees earned', value: sumOf(earnings, (a) => bd(a).earnedDeliveryFee), kind: 'money' },
                  { label: 'COD handling fees', value: sumOf(earnings, (a) => bd(a).codFee), kind: 'money' },
                  { label: "Agents' shares", value: -sumOf(earnings, (a) => bd(a).agentCut), kind: 'money', indent: true },
                  { label: 'Agency net earnings', value: earned, kind: 'money' },
                  { label: 'Earnings clawed back', value: -reversedTotal, kind: 'money' },
                  { label: 'Net earnings in period', value: earned - reversedTotal, kind: 'money' },
                  { label: 'Deliveries credited', value: earnings.length, kind: 'int' },
                  { label: 'COD cash collected by agents', value: sumOf(cashRows, (c) => c.expected_amount), kind: 'money' },
                  {
                      label: 'COD cash remitted to platform (confirmed)',
                      value: sumOf(remittanceRows.filter((r) => r.status === 'confirmed'), (r) => r.amount),
                      kind: 'money',
                  },
                  {
                      label: 'COD reserve held in period',
                      value: sumOf(reserveRows.filter((r) => r.held_at >= range.start && r.held_at < range.end), (r) => r.amount),
                      kind: 'money',
                  },
              ]
            : [
                  { label: 'Your share of delivery fees', value: earned, kind: 'money' },
                  { label: 'Earnings clawed back', value: -reversedTotal, kind: 'money' },
                  { label: 'Net earnings in period', value: earned - reversedTotal, kind: 'money' },
                  { label: 'Deliveries credited', value: earnings.length, kind: 'int' },
                  { label: 'COD cash you collected', value: sumOf(cashRows, (c) => c.expected_amount), kind: 'money' },
                  {
                      label: 'Cash you handed over (confirmed)',
                      value: sumOf(depositRows.filter((d) => d.status === 'confirmed'), (d) => d.amount),
                      kind: 'money',
                  },
              ];

    if (writeOffs.length > 0) {
        // Informational, outside the net arithmetic: forgiving a debt is not an earning.
        summary.push({ label: 'Refund debt written off by the platform', value: sumOf(writeOffs, (w) => w.amount), kind: 'money' });
    }

    const notes = [
        'Earnings are dated when they were credited: at delivery for a prepaid order, at cash collection for cash on delivery.',
        'COD cash is a liability you hold on the platform\'s behalf until it is remitted — it is not income, and is shown separately from earnings.',
    ];
    if (unsplit > 0) {
        notes.push(`${unsplit} cash-on-delivery run(s) have no recorded delivery fee, so their COD fee cannot be separated and is left blank.`);
    }

    return {
        sections,
        summary,
        notes,
        currency: created[0]?.currency ?? cashRows[0]?.currency ?? null,
    };
}

import { ObjectId } from 'mongodb';
import {
    AllocationRow,
    CollectionRow,
    OrderRow,
    PaymentRow,
    Range,
    RemittanceRow,
    ShipmentRow,
    StatementAllocationRepository,
    StatementBookingRepository,
    StatementCashCollectionRepository,
    StatementCustomerRepository,
    StatementOrderRepository,
    StatementPaymentRepository,
    StatementRefundRepository,
    StatementRemittanceRepository,
    StatementShipmentRepository,
    StatementTimelineRepository,
} from '../repositories/statement.read.repository';
import {
    apportionBargainFee,
    collectionCashBreakdown,
    customerPaidDeliveryFee,
    vendorBorneDeliveryFee,
    vendorSaleBreakdown,
    VendorSaleBreakdown,
} from './money-breakdown';
import { maskPhone } from './statement-masking';
import { allocationStatusLabel, col, idOf, loadNames, NameBook, sumOf } from './statement-common';
import { StatementRow, StatementSection, SummaryLine } from './statement.types';

const allocations = new StatementAllocationRepository();
const orders = new StatementOrderRepository();
const customers = new StatementCustomerRepository();
const timeline = new StatementTimelineRepository();
const payments = new StatementPaymentRepository();
const refunds = new StatementRefundRepository();
const shipments = new StatementShipmentRepository();
const collections = new StatementCashCollectionRepository();
const remittances = new StatementRemittanceRepository();
const bookings = new StatementBookingRepository();

/**
 * How close a remittance's confirmation must be to a collection's `settled_at` to be named as
 * the one that settled it. Both instants are stamped inside ONE transaction
 * (`cod-settlement.service.ts` `applyFifoInSession`), each with its own `new Date()`, so they
 * differ by milliseconds; a minute is generous and still cannot confuse two confirmations of
 * the same agency, which an administrator performs one at a time.
 */
const REMITTANCE_MATCH_MS = 60_000;

export function matchRemittance(collection: CollectionRow, confirmed: RemittanceRow[]): RemittanceRow | null {
    if (!collection.settled_at) return null;
    const at = collection.settled_at.getTime();
    let best: RemittanceRow | null = null;
    for (const r of confirmed) {
        if (!r.resolved_at || !r.agency_id.equals(collection.agency_id)) continue;
        const gap = Math.abs(r.resolved_at.getTime() - at);
        if (gap <= REMITTANCE_MATCH_MS && (!best || gap < Math.abs(best.resolved_at!.getTime() - at))) best = r;
    }
    return best;
}

const firstStatusAt = (s: ShipmentRow, ...statuses: string[]) =>
    s.status_history?.find((h) => statuses.includes(h.status))?.changed_at ?? null;

/**
 * The settled CHECKOUT payment for an order: SUCCEEDED/REFUNDED over anything still open.
 *
 * ⚠ Excludes `purpose: 'order_delivery_topup'` (jovi-mall ADR-A11 W-E, decided W-G2). A top-up
 * carries `orderId` exactly like a single-order payment, and this row's meaning is "how the
 * order was paid" — its means, reference, payer and paid-at. A top-up is a second, later charge
 * for delivery alone; picked here it would print the top-up's gateway reference as the order's.
 * What the customer paid IN TOTAL is not lost: the row's `total` is `order.total_amount`, which
 * jovi-mall grows by every applied top-up (`delivery-fee-topup.service.ts`).
 */
export function paymentFor(orderId: ObjectId, rows: PaymentRow[]): PaymentRow | null {
    const mine = rows.filter(
        (p) =>
            p.purpose !== 'order_delivery_topup' &&
            (p.orderId?.equals(orderId) || p.orderIds?.some((o) => o.equals(orderId))),
    );
    return mine.find((p) => p.status === 'SUCCEEDED' || p.status === 'REFUNDED') ?? mine[mine.length - 1] ?? null;
}

export interface VendorStatementParts {
    sections: StatementSection[];
    summary: SummaryLine[];
    notes: string[];
    currency: string | null;
}

export async function vendorStatement(vendorId: string, range: Range): Promise<VendorStatementParts> {
    const [created, reversed, refundRows] = await Promise.all([
        allocations.createdFor('vendor', vendorId, range),
        allocations.reversedFor('vendor', vendorId, range),
        refunds.forVendor(vendorId, range),
    ]);

    const sales = created.filter((a) => a.source_type === 'order' || a.source_type === 'cod_collection');
    const bookingIncome = created.filter((a) => a.source_type === 'booking');
    const deliveryCredits = created.filter((a) => a.source_type === 'shipment');

    // ── Resolve every source to its order ──────────────────────────────────────
    const codSourceIds = [...sales, ...reversed].filter((a) => a.source_type === 'cod_collection').map((a) => a.source_id);
    const shipmentSourceIds = [...deliveryCredits, ...reversed].filter((a) => a.source_type === 'shipment').map((a) => a.source_id);
    const [codRows, creditShipments, siblings] = await Promise.all([
        collections.byIds(codSourceIds),
        shipments.byIds(shipmentSourceIds),
        allocations.forSources([...sales, ...bookingIncome].map((a) => ({ type: a.source_type, id: a.source_id }))),
    ]);
    const collectionById = new Map(codRows.map((c) => [idOf(c._id), c]));
    const shipmentById = new Map(creditShipments.map((s) => [idOf(s._id), s]));

    const orderIdOf = (a: AllocationRow): ObjectId | null => {
        if (a.source_type === 'order') return a.source_id;
        if (a.source_type === 'cod_collection') return collectionById.get(idOf(a.source_id))?.order_id ?? null;
        if (a.source_type === 'shipment') return shipmentById.get(idOf(a.source_id))?.order_id ?? null;
        return null;
    };
    const orderIds = [
        ...[...sales, ...reversed, ...deliveryCredits].map(orderIdOf),
        ...refundRows.map((r) => r.orderId ?? null),
    ].filter((id): id is ObjectId => !!id);

    const [orderRows, orderShipments, orderCollections, paymentRows, timelineRows, bookingRows] = await Promise.all([
        orders.byIds(orderIds),
        shipments.forOrders(orderIds),
        collections.forOrders(orderIds),
        payments.forOrders(orderIds),
        timeline.forOrders(orderIds),
        bookings.byIds(bookingIncome.map((a) => a.source_id)),
    ]);
    const [customerRows, confirmedRemittances, names] = await Promise.all([
        customers.byIds(orderRows.map((o) => o.customer_id)),
        remittances.confirmedFor(orderCollections.map((c) => c.agency_id)),
        loadNames({
            agencies: orderShipments.map((s) => s.agency_id),
            agents: [
                ...orderShipments.map((s) => s.agent_id).filter((id): id is ObjectId => !!id),
                ...orderCollections.map((c) => c.agent_id),
            ],
        }),
    ]);

    const orderById = new Map(orderRows.map((o) => [idOf(o._id), o]));
    const customerById = new Map(customerRows.map((c) => [idOf(c._id), c]));
    const orderNo = (id: ObjectId | null | undefined) => (id ? orderById.get(idOf(id))?.order_number ?? idOf(id) : '');

    // ── Breakdown per sale ─────────────────────────────────────────────────────
    const siblingsOf = (a: AllocationRow) =>
        siblings.filter((s) => s.source_type === a.source_type && s.source_id.equals(a.source_id));
    const amountOf = (rows: AllocationRow[], type: string) => sumOf(rows.filter((r) => r.beneficiary_type === type), (r) => r.amount);

    const breakdowns = new Map<string, VendorSaleBreakdown>();
    for (const a of sales) {
        const sib = siblingsOf(a);
        let deliveryFeeSnapshot: number | null = null;
        if (a.source_type === 'cod_collection') {
            const shipmentId = collectionById.get(idOf(a.source_id))?.shipment_id;
            const s = shipmentId ? orderShipments.find((x) => x._id.equals(shipmentId)) : undefined;
            // The VENDOR-BORNE part, not the agency's whole fee: on a customer-paid shipment the
            // customer's cash covered the fee and the residual holds only the COD fee (ADR-A11).
            deliveryFeeSnapshot = s ? vendorBorneDeliveryFee(s) : null;
        }
        breakdowns.set(
            idOf(a._id),
            vendorSaleBreakdown({
                sourceType: a.source_type as 'order' | 'cod_collection',
                gross: a.gross_snapshot,
                net: a.amount,
                commission: amountOf(sib, 'platform'),
                bargainFee: amountOf(sib, 'platform_ai'),
                deliveryFeeSnapshot,
            }),
        );
    }
    const bd = (a: AllocationRow) => breakdowns.get(idOf(a._id))!;
    const unsplit = sales.filter((a) => bd(a).deliveryFee === null);

    // Bargain fee per ORDER (a COD order can carry several collections).
    const bargainByOrder = new Map<string, number>();
    for (const a of sales) {
        const oid = orderIdOf(a);
        if (oid) bargainByOrder.set(idOf(oid), (bargainByOrder.get(idOf(oid)) ?? 0) + bd(a).bargainFee);
    }
    const receivedAtByOrder = new Map<string, Date>();
    for (const a of sales) {
        const oid = orderIdOf(a);
        if (oid && !receivedAtByOrder.has(idOf(oid))) receivedAtByOrder.set(idOf(oid), a.created_at);
    }

    // ── Sections ───────────────────────────────────────────────────────────────
    const salesSection: StatementSection = {
        key: 'sales',
        title: 'Sales and deductions',
        description:
            'One row per payment received: an online order when it was paid, a cash-on-delivery shipment when the agent ' +
            'collected the cash. Gross is what the goods sold for — delivery a customer paid is not part of it. ' +
            'Net = gross − bargain fee − commission − delivery fee − COD fee, and is what was credited to your earnings ' +
            'balance. "Delivery fee" is the part of the delivery cost YOUR shop paid: the whole fee when your shop offers ' +
            'free delivery, nothing when the customer paid it.',
        columns: [
            col.at('receivedAt', 'Money received'),
            col.text('order', 'Order', 18),
            col.text('kind', 'Payment', 14),
            col.money('gross', 'Gross'),
            col.money('bargainFee', 'Bargain fee'),
            col.money('commission', 'Commission'),
            col.text('commissionPct', 'Comm. %', 7),
            col.money('deliveryFee', 'Delivery fee (yours)'),
            col.money('codFee', 'COD fee'),
            col.money('net', 'Net to you'),
            col.text('status', 'Status', 20),
            col.at('releasedAt', 'Available since'),
        ],
        rows: sales.map((a) => {
            const b = bd(a);
            return {
                receivedAt: a.created_at,
                order: orderNo(orderIdOf(a)),
                kind: a.source_type === 'order' ? 'Online' : 'Cash on delivery',
                gross: b.gross,
                bargainFee: b.bargainFee,
                commission: b.commission,
                commissionPct: `${a.commission_percent_snapshot}%`,
                deliveryFee: b.deliveryFee ?? b.deliveryAndCod,
                codFee: b.codFee,
                net: b.net,
                status: allocationStatusLabel(a),
                releasedAt: a.released_at ?? null,
            };
        }),
        totals: ['gross', 'bargainFee', 'commission', 'deliveryFee', 'codFee', 'net'],
    };

    const touchedOrders = [...orderById.values()].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    const ordersSection: StatementSection = {
        key: 'orders',
        title: 'Orders',
        description:
            'Every order behind a movement in this period. Phone numbers are partly hidden. "Paid by" is the person ' +
            'who completed the payment where it was recorded; see the notes on the summary page. "Order total" is what the ' +
            'customer paid: the goods plus any delivery the customer paid for.',
        columns: [
            col.text('order', 'Order', 18),
            col.at('placedAt', 'Placed'),
            col.text('customer', 'Placed by', 18),
            col.text('customerPhone', 'Phone', 15),
            col.text('paymentMethod', 'Payment', 14),
            col.text('means', 'Means', 16),
            col.text('paymentStatus', 'Payment status', 13),
            col.at('paidAt', 'Paid'),
            col.text('payer', 'Paid by', 22),
            col.text('reference', 'Payment reference', 22),
            col.money('goods', 'Goods'),
            col.money('customerDelivery', 'Delivery (customer)'),
            col.money('total', 'Order total'),
            col.text('deliveryPayer', 'Delivery paid by', 14),
            col.text('fulfilment', 'Fulfilment', 12),
            col.at('completedAt', 'Completed'),
            col.text('agencies', 'Agency', 18),
            col.text('agents', 'Agent', 18),
        ],
        rows: touchedOrders.map((o) => orderRow(o, customerById, paymentRows, orderShipments, orderCollections, receivedAtByOrder, names)),
        pdf: 'xlsx-only',
    };

    const lineRows: StatementRow[] = [];
    for (const o of touchedOrders) {
        const shares = apportionBargainFee(
            o.items.map((i) => ({
                lineId: idOf(i._id),
                unitPricePaid: i.price,
                quantity: i.quantity,
                floorPriceSnapshot: i.floor_price_snapshot ?? null,
            })),
            bargainByOrder.get(idOf(o._id)) ?? 0,
        );
        for (const i of o.items) {
            lineRows.push({
                order: o.order_number,
                product: i.title ?? null,
                sku: i.sku ?? null,
                quantity: i.quantity,
                listPrice: i.list_price_snapshot ?? null,
                floorPrice: i.floor_price_snapshot ?? null,
                finalPrice: i.price,
                negotiated: i.negotiated_unit_price != null ? 'Yes' : 'No',
                lineTotal: i.price * i.quantity,
                bargainFee: shares.get(idOf(i._id)) ?? 0,
            });
        }
    }
    const linesSection: StatementSection = {
        key: 'order_lines',
        title: 'Products sold',
        description:
            'Each product on those orders. "Final price" is the unit price the customer actually paid — the negotiated ' +
            'price when the item was bargained. The bargain fee is 30% of the amount agreed above your floor price.',
        columns: [
            col.text('order', 'Order', 18),
            col.text('product', 'Product', 28),
            col.text('sku', 'SKU', 14),
            col.int('quantity', 'Qty', 5),
            col.money('listPrice', 'Listed price'),
            col.money('floorPrice', 'Your floor'),
            col.money('finalPrice', 'Final price'),
            col.text('negotiated', 'Bargained', 9),
            col.money('lineTotal', 'Line total'),
            col.money('bargainFee', 'Bargain fee'),
        ],
        rows: lineRows,
        totals: ['lineTotal', 'bargainFee'],
        pdf: 'xlsx-only',
    };

    const deliveriesSection: StatementSection = {
        key: 'deliveries',
        title: 'Deliveries',
        description:
            'Every shipment of those orders: who carried it, what the agency charged for it, who paid that fee, and when ' +
            'it moved. "Your share" is what your shop paid of the fee; the rest was paid by the customer.',
        columns: [
            col.text('order', 'Order', 18),
            col.text('tracking', 'Tracking #', 16),
            col.text('agency', 'Agency', 18),
            col.text('agent', 'Agent', 18),
            col.text('status', 'Status', 14),
            col.money('fee', 'Delivery fee'),
            col.text('payer', 'Paid by', 10),
            col.money('customerPaid', 'Customer paid'),
            col.money('vendorShare', 'Your share'),
            col.at('assignedAt', 'Assigned'),
            col.at('pickedUpAt', 'Picked up'),
            col.at('deliveredAt', 'Delivered'),
            col.at('endedOtherwiseAt', 'Returned / failed'),
        ],
        rows: orderShipments.map((s) => ({
            order: orderNo(s.order_id),
            tracking: s.tracking_number ?? null,
            agency: names.agency(s.agency_id),
            agent: names.agent(s.agent_id),
            status: s.status,
            fee: s.delivery_fee_snapshot ?? null,
            payer: payerLabel(s.delivery_payer),
            customerPaid: customerPaidDeliveryFee(s),
            vendorShare: vendorBorneDeliveryFee(s),
            assignedAt: firstStatusAt(s, 'assigned'),
            pickedUpAt: firstStatusAt(s, 'picked_up'),
            deliveredAt: firstStatusAt(s, 'agent_delivered', 'delivered'),
            endedOtherwiseAt: firstStatusAt(s, 'returned', 'failed'),
        })),
        totals: ['fee', 'customerPaid', 'vendorShare'],
        pdf: 'xlsx-only',
    };

    const codSection: StatementSection = {
        key: 'cod',
        title: 'Cash on delivery — collection and remittance',
        description:
            'For each cash-on-delivery shipment: who collected the cash, and when the agency settled it to the platform. ' +
            'Your earnings for a COD sale become available only after that settlement. "Amount" is all the cash the agent ' +
            'collected: the goods plus any delivery fee the customer paid in cash, which goes to the delivery side, not to you.',
        columns: [
            col.text('order', 'Order', 18),
            col.text('agent', 'Collected by', 18),
            col.money('goods', 'Goods'),
            col.money('deliveryFee', 'Delivery fee'),
            col.money('amount', 'Amount'),
            col.text('status', 'Status', 11),
            col.at('collectedAt', 'Collected'),
            col.text('confirmation', 'Confirmation', 14),
            col.at('settledAt', 'Settled to platform'),
            col.text('remittedBy', 'Remitted by (agency)', 18),
            col.text('remittanceRef', 'Remittance ref.', 16),
            col.text('confirmedBy', 'Confirmed by', 16),
        ],
        rows: orderCollections.map((c) => {
            const r = matchRemittance(c, confirmedRemittances);
            const cash = collectionCashBreakdown(c);
            return {
                order: orderNo(c.order_id),
                agent: names.agent(c.agent_id),
                goods: cash.itemsAmount,
                deliveryFee: cash.deliveryFeeAmount,
                amount: c.expected_amount,
                status: c.status,
                collectedAt: c.collected_at ?? null,
                confirmation: c.verification?.method === 'code' ? 'Customer code' : c.verification?.method ? 'Automatic' : null,
                settledAt: c.settled_at ?? null,
                remittedBy: c.settled_at ? names.agency(c.agency_id) : null,
                remittanceRef: r?.reference ?? null,
                confirmedBy: r?.resolved_by_name ?? null,
            };
        }),
        totals: ['goods', 'deliveryFee', 'amount'],
    };

    const adjustmentsSection: StatementSection = {
        key: 'adjustments',
        title: 'Adjustments to your earnings',
        description:
            'Changes to money already credited: earnings reversed after a full refund (−), and delivery fees returned to ' +
            'you when a shipment earned less than was reserved, e.g. a return (+).',
        columns: [
            col.at('at', 'Date'),
            col.text('kind', 'Adjustment', 22),
            col.text('order', 'Order', 18),
            col.money('amount', 'Amount'),
            col.text('status', 'Status', 20),
        ],
        rows: [
            ...reversed.map((a) => ({
                at: a.reversed_at ?? null,
                kind: 'Earnings reversed',
                order: orderNo(orderIdOf(a)),
                amount: -a.amount,
                status: 'Reversed',
            })),
            ...deliveryCredits.map((a) => ({
                at: a.created_at,
                kind: 'Delivery fee returned',
                order: orderNo(orderIdOf(a)),
                amount: a.amount,
                status: allocationStatusLabel(a),
            })),
        ],
        totals: ['amount'],
    };

    const refundsSection: StatementSection = {
        key: 'refunds',
        title: 'Refunds to customers',
        description:
            'Refunds paid back to your customers in this period. What they did to your earnings is in the adjustments ' +
            'table: a full refund reverses earnings that were still held.',
        columns: [
            col.at('at', 'Requested'),
            col.text('reference', 'Order / booking', 18),
            col.money('amount', 'Refunded'),
            col.text('status', 'Status', 10),
            col.text('initiatedBy', 'Initiated by', 12),
            col.text('reason', 'Reason', 28),
            col.at('completedAt', 'Completed'),
        ],
        rows: refundRows.map((r) => ({
            at: r.createdAt,
            reference: r.orderId ? orderNo(r.orderId) : r.bookingId ? `Booking ${idOf(r.bookingId)}` : null,
            amount: r.refundAmount,
            status: r.status,
            initiatedBy: r.initiatedByRole ?? null,
            reason: r.reason ?? null,
            completedAt: r.completedAt ?? null,
        })),
        totals: ['amount'],
    };

    const bookingById = new Map(bookingRows.map((b) => [idOf(b._id), b]));
    const bookingsSection: StatementSection = {
        key: 'bookings',
        title: 'Service bookings',
        description: 'Booking payments credited in this period. Bookings carry commission only — no delivery or COD fee.',
        columns: [
            col.at('receivedAt', 'Money received'),
            col.text('booking', 'Booking', 18),
            col.at('scheduledFor', 'Scheduled for'),
            col.text('status', 'Booking status', 12),
            col.money('gross', 'Gross'),
            col.money('commission', 'Commission'),
            col.money('net', 'Net to you'),
            col.text('allocation', 'Status', 20),
        ],
        rows: bookingIncome.map((a) => {
            const b = bookingById.get(idOf(a.source_id));
            return {
                receivedAt: a.created_at,
                booking: b?.bookingNumber ?? idOf(a.source_id),
                scheduledFor: b?.startAt ?? null,
                status: b?.status ?? null,
                gross: a.gross_snapshot,
                commission: amountOf(siblingsOf(a), 'platform'),
                net: a.amount,
                allocation: allocationStatusLabel(a),
            };
        }),
        totals: ['gross', 'commission', 'net'],
    };

    const timelineSection: StatementSection = {
        key: 'timeline',
        title: 'Order timeline',
        description: 'Every recorded event on those orders, oldest first.',
        columns: [
            col.text('order', 'Order', 18),
            col.at('at', 'When'),
            col.text('event', 'Event', 20),
            col.text('description', 'Detail', 40),
            col.text('by', 'By', 10),
        ],
        rows: timelineRows.map((t) => ({
            order: orderNo(t.order_id),
            at: t.created_at,
            event: t.event_type,
            description: t.description,
            by: t.actor_type,
        })),
        pdf: 'xlsx-only',
    };

    // ── Summary ────────────────────────────────────────────────────────────────
    const total = (key: keyof VendorSaleBreakdown) => sumOf(sales, (a) => bd(a)[key] as number | null);
    const bookingNet = sumOf(bookingIncome, (a) => a.amount);
    const credited = sumOf(deliveryCredits, (a) => a.amount);
    const reversedTotal = sumOf(reversed, (a) => a.amount);

    const summary: SummaryLine[] = [
        { label: 'Total sales (gross)', value: total('gross'), kind: 'money' },
        { label: 'Bargain fee', value: -total('bargainFee'), kind: 'money', indent: true },
        { label: 'Commission', value: -total('commission'), kind: 'money', indent: true },
        ...(unsplit.length === 0
            ? [
                  { label: 'Delivery fees', value: -total('deliveryFee'), kind: 'money' as const, indent: true },
                  { label: 'COD fees', value: -total('codFee'), kind: 'money' as const, indent: true },
              ]
            : [{ label: 'Delivery + COD fees', value: -total('deliveryAndCod'), kind: 'money' as const, indent: true }]),
        { label: 'Net revenue from sales', value: total('net'), kind: 'money' },
        { label: 'Booking income (net)', value: bookingNet, kind: 'money' },
        { label: 'Delivery fees returned', value: credited, kind: 'money' },
        { label: 'Earnings reversed', value: -reversedTotal, kind: 'money' },
        { label: 'Net earnings in period', value: total('net') + bookingNet + credited - reversedTotal, kind: 'money' },
        { label: 'Orders with money received', value: receivedAtByOrder.size, kind: 'int' },
        { label: 'Refunds paid to customers', value: sumOf(refundRows.filter((r) => r.status === 'completed'), (r) => r.refundAmount), kind: 'money' },
        // Informational, outside the net arithmetic above: delivery the customers paid on the
        // orders behind this period's movements. It went to the delivery side, never to the shop.
        { label: 'Delivery paid by customers (to agencies)', value: sumOf(touchedOrders, (o) => customerDeliveryOf(o)), kind: 'money' },
    ];

    const notes = [
        'Net revenue = gross − bargain fee − commission − delivery fee − COD fee, read from the amounts recorded when each payment was split.',
        'Gross is the goods only. Where your shop\'s delivery terms made the customer pay delivery, that fee is shown in the order and ' +
            'delivery tables but is not part of your gross or your net: it was paid to the delivery agency, and the "Delivery fee" ' +
            'deduction is only the part your shop paid.',
        '"Paid by": the platform began recording the payer separately from the customer on shareable payment links in September 2026. ' +
            'Earlier online payments show the ordering customer; cash-on-delivery sales show the agent who collected the cash.',
        '"Listed price" (the price shown before bargaining) is recorded from September 2026; earlier lines leave it blank.',
    ];
    if (unsplit.length > 0) {
        notes.push(
            `${unsplit.length} cash-on-delivery sale(s) have no recorded delivery fee, so their delivery and COD fees are shown ` +
                'together in the "Delivery fee" column and the COD fee is left blank.',
        );
    }

    return {
        sections: [salesSection, ordersSection, linesSection, deliveriesSection, codSection, adjustmentsSection, refundsSection, bookingsSection, timelineSection],
        summary,
        notes,
        currency: created[0]?.currency ?? reversed[0]?.currency ?? null,
    };
}

/** Who paid a delivery, in words. `null`/absent predates customer-paid delivery and IS the shop. */
function payerLabel(payer: 'vendor' | 'customer' | null | undefined): string {
    return payer === 'customer' ? 'Customer' : 'Your shop';
}

/**
 * What the customer was charged for delivery on this order — `price_breakdown.delivery`, 0 when
 * absent (every order before ADR-A11, and every vendor-paid one).
 */
function customerDeliveryOf(o: OrderRow): number {
    const d = o.price_breakdown?.delivery;
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * The order's goods — mirrors jovi-mall's `orderItemsGrossOf`: `price_breakdown.base` when
 * written (every order checkout produced), else the total minus customer-paid delivery.
 */
function orderGoodsOf(o: OrderRow): number {
    const base = o.price_breakdown?.base;
    return typeof base === 'number' && Number.isFinite(base) ? base : o.total_amount - customerDeliveryOf(o);
}

function orderRow(
    o: OrderRow,
    customerById: Map<string, { name?: string; phone?: string | null }>,
    paymentRows: PaymentRow[],
    orderShipments: ShipmentRow[],
    orderCollections: CollectionRow[],
    receivedAtByOrder: Map<string, Date>,
    names: NameBook,
): StatementRow {
    const customer = o.customer_snapshot ?? customerById.get(idOf(o.customer_id)) ?? null;
    const isCod = o.payment_method === 'cash_on_delivery';
    const payment = isCod ? null : paymentFor(o._id, paymentRows);
    const mine = orderShipments.filter((s) => s.order_id.equals(o._id));
    const cash = orderCollections.filter((c) => c.order_id.equals(o._id));
    const lastCollected = cash.map((c) => c.collected_at).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
    const collectors = [...new Set(cash.map((c) => names.agent(c.agent_id)).filter(Boolean))];

    let payer: string | null;
    if (isCod) payer = collectors.length ? `Cash to agent ${collectors.join(', ')}` : null;
    else if (payment?.payer?.name || payment?.payer?.phone)
        payer = [payment.payer.name, maskPhone(payment.payer.phone)].filter(Boolean).join(' · ');
    else payer = payment ? 'Ordering customer (payer not recorded)' : null;

    return {
        order: o.order_number,
        placedAt: o.created_at,
        customer: customer?.name ?? null,
        customerPhone: maskPhone(customer?.phone ?? null),
        paymentMethod: isCod ? 'Cash on delivery' : 'Online',
        means: isCod ? 'Cash' : payment ? `${payment.gateway} · ${payment.method}` : null,
        paymentStatus: o.payment_status,
        paidAt: isCod ? lastCollected ?? null : payment?.paidAt ?? receivedAtByOrder.get(idOf(o._id)) ?? null,
        payer,
        reference: payment?.gatewayRef || payment?.merchantRef || null,
        goods: orderGoodsOf(o),
        customerDelivery: customerDeliveryOf(o),
        total: o.total_amount,
        deliveryPayer: o.order_type === 'digital' ? null : payerLabel(o.delivery_payer),
        fulfilment: o.fulfillment_status,
        completedAt: o.completion?.confirmed_at ?? null,
        agencies: [...new Set(mine.map((s) => names.agency(s.agency_id)))].join(', ') || null,
        agents: [...new Set(mine.map((s) => names.agent(s.agent_id)).filter(Boolean))].join(', ') || null,
    };
}

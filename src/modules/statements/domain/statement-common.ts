import { ObjectId } from 'mongodb';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import {
    AllocationRow,
    PayoutRow,
    Range,
    StatementCreditTopupRepository,
    StatementCreditTxRepository,
    StatementPayoutRepository,
    StatementPlanPurchaseRepository,
    StatementSubscriberPlanRepository,
} from '../repositories/statement.read.repository';
import { StatementColumn, StatementOwnerType, StatementSection } from './statement.types';

/**
 * The parts every owner type's statement shares: names, payouts, credits, plans, and the
 * wallet adjustments (reversals).
 */

const stores = new StoreReadRepository();
const agencies = new AgencyReadRepository();
const agents = new AgentReadRepository();
const payouts = new StatementPayoutRepository();
const creditTx = new StatementCreditTxRepository();
const topups = new StatementCreditTopupRepository();
const planPurchases = new StatementPlanPurchaseRepository();
const subscriptions = new StatementSubscriberPlanRepository();

export const idOf = (id: ObjectId | null | undefined): string => (id ? id.toHexString() : '');

// ─────────────────────────────────────────────────────────────────────────────
// Column shorthands
// ─────────────────────────────────────────────────────────────────────────────

export const col = {
    text: (key: string, header: string, width = 16): StatementColumn => ({ key, header, kind: 'text', width }),
    money: (key: string, header: string, width = 13): StatementColumn => ({ key, header, kind: 'money', width }),
    int: (key: string, header: string, width = 8): StatementColumn => ({ key, header, kind: 'int', width }),
    at: (key: string, header: string, width = 17): StatementColumn => ({ key, header, kind: 'datetime', width }),
};

/** Allocation status in words a vendor understands. */
export function allocationStatusLabel(row: Pick<AllocationRow, 'status' | 'requires_cash_settlement' | 'cash_settled_at'>): string {
    if (row.status === 'reversed') return 'Reversed';
    if (row.status === 'released') return 'Available (released)';
    if (row.requires_cash_settlement && !row.cash_settled_at) return 'Held — awaiting cash remittance';
    return 'Held — escrow';
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

export interface NameBook {
    vendor(id: ObjectId | null | undefined): string;
    agency(id: ObjectId | null | undefined): string;
    agent(id: ObjectId | null | undefined): string;
}

export async function loadNames(ids: {
    vendors?: ObjectId[];
    agencies?: ObjectId[];
    agents?: ObjectId[];
}): Promise<NameBook> {
    const [v, a, g] = await Promise.all([
        ids.vendors?.length ? stores.findNamesByVendorIds(ids.vendors) : new Map<string, string | null>(),
        ids.agencies?.length ? agencies.findNamesByIds(ids.agencies) : new Map<string, string | null>(),
        ids.agents?.length ? agents.findNamesByIds(ids.agents) : new Map<string, string | null>(),
    ]);
    const pick = (map: Map<string, string | null>) => (id: ObjectId | null | undefined) =>
        id ? map.get(id.toHexString()) ?? '(unnamed)' : '';
    return { vendor: pick(v), agency: pick(a), agent: pick(g) };
}

export async function ownerName(type: StatementOwnerType, id: string): Promise<string | null> {
    const book = await loadNames({ [type === 'vendor' ? 'vendors' : type === 'agency' ? 'agencies' : 'agents']: [new ObjectId(id)] });
    const name = book[type](new ObjectId(id));
    return name === '(unnamed)' ? null : name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared sections
// ─────────────────────────────────────────────────────────────────────────────

export interface CommonSections {
    sections: StatementSection[];
    payoutsPaid: number;
    payoutsOpen: number;
    creditPacksSpent: number;
    plansSpent: number;
}

function payoutMethodLabel(row: PayoutRow): string {
    const snap = row.payout_method_snapshot;
    if (!snap?.method) return 'Not recorded';
    const provider = snap.mobile_money?.provider ?? snap.bank?.bank_name ?? null;
    return provider ? `${snap.method} · ${provider}` : snap.method;
}

export async function commonSections(type: StatementOwnerType, id: string, range: Range): Promise<CommonSections> {
    const [payoutRows, txRows, topupRows, purchaseRows, subRows] = await Promise.all([
        payouts.touchedFor(type, id, range),
        creditTx.createdFor(type, id, range),
        topups.createdFor(type, id, range),
        planPurchases.createdFor(type, id, range),
        subscriptions.overlapping(type, id, range),
    ]);

    const inPeriod = (d: Date | null | undefined) => !!d && d >= range.start && d < range.end;
    const payoutsPaid = payoutRows
        .filter((p) => p.status === 'paid' && inPeriod(p.resolved_at))
        .reduce((s, p) => s + p.amount, 0);
    const payoutsOpen = payoutRows
        .filter((p) => p.status === 'pending' || p.status === 'processing')
        .reduce((s, p) => s + p.amount, 0);
    const creditPacksSpent = topupRows.filter((t) => t.status === 'paid').reduce((s, t) => s + t.price, 0);
    const plansSpent = purchaseRows.filter((p) => p.status === 'paid' || p.status === 'active').reduce((s, p) => s + p.price, 0);

    const sections: StatementSection[] = [
        {
            key: 'payouts',
            title: 'Payouts',
            description:
                'Withdrawals from your available balance to your payout account, requested or settled in this period. ' +
                'The account number is never printed.',
            columns: [
                col.at('requestedAt', 'Requested'),
                col.money('amount', 'Amount'),
                col.text('status', 'Status', 12),
                col.text('origin', 'Origin', 12),
                col.text('method', 'Paid to', 18),
                col.at('resolvedAt', 'Settled / resolved'),
                col.text('resolvedBy', 'Resolved by', 16),
                col.text('reference', 'Reference / reason', 24),
            ],
            rows: payoutRows.map((p) => ({
                requestedAt: p.created_at,
                amount: p.amount,
                status: p.status,
                origin: p.origin === 'auto_threshold' ? 'Automatic' : 'Requested',
                method: payoutMethodLabel(p),
                resolvedAt: p.resolved_at ?? null,
                resolvedBy: p.resolved_by_name ?? null,
                reference: p.paid_reference ?? p.rejection_reason ?? p.transfer_failure_reason ?? null,
            })),
            totals: ['amount'],
        },
        {
            key: 'credit_purchases',
            title: 'Credit pack purchases',
            description: 'Money paid to buy credit packs. Credits themselves are not money — their movements are the next table.',
            columns: [
                col.at('at', 'Date'),
                col.text('pack', 'Pack', 14),
                col.int('credits', 'Credits'),
                col.money('price', 'Price paid'),
                col.text('status', 'Status', 10),
                col.at('paidAt', 'Paid'),
                col.text('gateway', 'Paid via', 12),
                col.text('reference', 'Gateway reference', 22),
            ],
            rows: topupRows.map((t) => ({
                at: t.created_at,
                pack: t.pack_code,
                credits: t.credits,
                price: t.price,
                status: t.status,
                paidAt: t.paid_at ?? null,
                gateway: t.gateway ?? null,
                reference: t.gateway_ref ?? null,
            })),
            totals: ['price'],
        },
        {
            key: 'credit_movements',
            title: 'Credit movements',
            description:
                'Every credit granted (plan allowance, pack), spent (AI vectorisation, WhatsApp templates) or adjusted. ' +
                'Units are CREDITS, not currency.',
            columns: [
                col.at('at', 'Date'),
                col.text('type', 'Type', 12),
                col.text('reason', 'Reason', 22),
                col.int('amount', 'Credits'),
                col.int('balanceAfter', 'Balance after', 10),
                col.text('ref', 'Reference', 20),
            ],
            rows: txRows.map((t) => ({
                at: t.created_at,
                type: t.type,
                reason: t.reason_code,
                amount: t.amount,
                balanceAfter: t.balance_after,
                ref: t.ref ?? null,
            })),
            pdf: 'xlsx-only',
        },
        {
            key: 'plans',
            title: 'Plans',
            description: 'Plan purchases in this period, and every subscription in force during it.',
            columns: [
                col.text('kind', 'Record', 12),
                col.text('plan', 'Plan', 14),
                col.money('price', 'Price paid'),
                col.text('status', 'Status', 14),
                col.at('at', 'Date'),
                col.at('paidAt', 'Paid'),
                col.at('startedAt', 'Started'),
                col.at('expiresAt', 'Expires'),
                col.text('by', 'Assigned by / via', 18),
                col.text('reference', 'Reference', 20),
            ],
            rows: [
                ...purchaseRows.map((p) => ({
                    kind: 'Purchase',
                    plan: p.plan_code,
                    price: p.price,
                    status: p.status,
                    at: p.created_at,
                    paidAt: p.paid_at ?? null,
                    startedAt: null,
                    expiresAt: null,
                    by: p.gateway ?? null,
                    reference: p.gateway_ref ?? null,
                })),
                ...subRows.map((s) => ({
                    kind: 'Subscription',
                    plan: s.plan_code,
                    price: null,
                    status: s.status,
                    at: s.created_at,
                    paidAt: null,
                    startedAt: s.started_at ?? null,
                    expiresAt: s.expires_at ?? null,
                    by: s.assigned_by_name ?? s.assigned_by_source ?? null,
                    reference: s.payment_reference ?? null,
                })),
            ],
            totals: ['price'],
        },
    ];

    return { sections, payoutsPaid, payoutsOpen, creditPacksSpent, plansSpent };
}

/** Sum of a numeric key over rows, treating null as 0. */
export function sumOf<T>(rows: T[], pick: (row: T) => number | null | undefined): number {
    return rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
}

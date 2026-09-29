import {
    CreditTopupGatewayStatsReadRepository,
    GatewayStatsRow,
    GatewayStatsSource,
    PaymentGatewayStatsReadRepository,
    PlanPurchaseGatewayStatsReadRepository,
    STUCK_PENDING_AFTER_MINUTES,
} from '../../money/repositories/payment-transaction.read.repository';

/**
 * Per-aggregator outcomes for the payment-routing screen (jovi-mall ADR-A08, owner decision 6).
 *
 * Computed HERE, directly on `jovi_mall`, rather than asked of jovi-mall — the read rule every
 * other money surface in this service follows (ADR-009 D-1: a record is read, a verdict is
 * asked). Counts of settled rows are records. It also means the numbers still load when the
 * platform is too old to have a routing endpoint, which is exactly when an operator wants them.
 */

export type PaymentStatsWindow = '24h' | '7d';

const WINDOW_MS: Readonly<Record<PaymentStatsWindow, number>> = Object.freeze({
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
});

export interface GatewayOutcomeSummary {
    gateway: string;
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
    stuckPending: number;
    /**
     * `succeeded / (succeeded + failed)` — over DECIDED rows only. Pending rows are left out,
     * because a burst of charges still waiting on customers' phones is not a failure yet, and
     * counting them would make every busy minute look like an outage. `null` when nothing was
     * decided in the window.
     */
    successRate: number | null;
    /** Latest across the three sources. `null` means none in the window, not "never". */
    lastSuccessAt: string | null;
    /**
     * Per collection, because settle-time percentiles cannot be merged across sources — and
     * because an aggregator failing only on billing is a real, distinct fault.
     */
    sources: Array<Omit<GatewayStatsRow, 'gateway' | 'lastSuccessAt'> & { lastSuccessAt: string | null }>;
}

export interface PaymentRoutingStats {
    window: PaymentStatsWindow;
    since: string;
    stuckPendingAfterMinutes: number;
    gateways: GatewayOutcomeSummary[];
}

const payments = new PaymentGatewayStatsReadRepository();
const planPurchases = new PlanPurchaseGatewayStatsReadRepository();
const creditTopups = new CreditTopupGatewayStatsReadRepository();

export async function collectPaymentRoutingStats(
    window: PaymentStatsWindow = '24h',
    now: Date = new Date(),
): Promise<PaymentRoutingStats> {
    const since = new Date(now.getTime() - WINDOW_MS[window]);

    const rows = (await Promise.all([
        payments.gatewayStats(since, now),
        planPurchases.gatewayStats(since, now),
        creditTopups.gatewayStats(since, now),
    ])).flat();

    return {
        window,
        since: since.toISOString(),
        stuckPendingAfterMinutes: STUCK_PENDING_AFTER_MINUTES,
        gateways: summariseByGateway(rows),
    };
}

/** Pure, and exported so `test-devtools.ts` can assert the fold without a database. */
export function summariseByGateway(rows: readonly GatewayStatsRow[]): GatewayOutcomeSummary[] {
    const byGateway = new Map<string, GatewayStatsRow[]>();
    for (const row of rows) {
        const list = byGateway.get(row.gateway) ?? [];
        list.push(row);
        byGateway.set(row.gateway, list);
    }

    const sum = (list: GatewayStatsRow[], key: 'total' | 'succeeded' | 'failed' | 'pending' | 'stuckPending') =>
        list.reduce((acc, row) => acc + row[key], 0);

    return [...byGateway.entries()]
        .map(([gateway, list]) => {
            const succeeded = sum(list, 'succeeded');
            const failed = sum(list, 'failed');
            const decided = succeeded + failed;
            const latest = list
                .map((row) => row.lastSuccessAt)
                .filter((value): value is Date => value instanceof Date)
                .sort((a, b) => b.getTime() - a.getTime())[0];

            return {
                gateway,
                total: sum(list, 'total'),
                succeeded,
                failed,
                pending: sum(list, 'pending'),
                stuckPending: sum(list, 'stuckPending'),
                successRate: decided === 0 ? null : Math.round((succeeded / decided) * 1000) / 1000,
                lastSuccessAt: latest ? latest.toISOString() : null,
                sources: list
                    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))
                    .map(({ gateway: _gateway, lastSuccessAt, ...rest }) => ({
                        ...rest,
                        lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
                    })),
            };
        })
        .sort((a, b) => b.total - a.total || a.gateway.localeCompare(b.gateway));
}

const SOURCE_ORDER: readonly GatewayStatsSource[] = ['payments', 'plan_purchases', 'credit_topups'];

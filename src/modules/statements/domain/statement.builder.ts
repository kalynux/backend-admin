import { commonSections, ownerName } from './statement-common';
import { deliveryStatement } from './delivery-statement';
import { StatementPeriod, STATEMENT_TZ_LABEL } from './statement-period';
import { StatementDocument, StatementOwnerType, SummaryLine } from './statement.types';
import { vendorStatement } from './vendor-statement';

/**
 * Assemble one owner's statement for one period.
 *
 * `balances` are the owner's CURRENT balances, asked of jovi-mall by the caller (ADR-009 D-1:
 * a balance is a verdict, and a second computation of it here would be a second opinion). They
 * are printed as "at the time of generation", never as a period-end balance — the ledger does
 * not carry payouts, so a period-end figure reconstructed from it would be wrong in exactly
 * the months the owner withdrew money.
 */
export interface OwnerBalances {
    pending: number | null;
    available: number | null;
    reserve: number | null;
    requested: number | null;
}

export async function buildStatement(input: {
    ownerType: StatementOwnerType;
    ownerId: string;
    period: StatementPeriod;
    balances: OwnerBalances | null;
    now?: Date;
}): Promise<StatementDocument> {
    const { ownerType, ownerId, period } = input;
    const range = { start: period.start, end: period.end };

    const [name, specific, common] = await Promise.all([
        ownerName(ownerType, ownerId),
        ownerType === 'vendor' ? vendorStatement(ownerId, range) : deliveryStatement(ownerType, ownerId, range),
        commonSections(ownerType, ownerId, range),
    ]);

    const summary: SummaryLine[] = [
        ...specific.summary,
        { label: 'Payouts paid in period', value: -common.payoutsPaid, kind: 'money' },
        { label: 'Payouts still open', value: common.payoutsOpen, kind: 'money' },
        { label: 'Credit packs bought', value: common.creditPacksSpent, kind: 'money' },
        { label: 'Plans bought', value: common.plansSpent, kind: 'money' },
    ];
    if (input.balances) {
        summary.push(
            { label: 'Balances now (at generation)', value: '', kind: 'text' },
            { label: 'Pending (in escrow)', value: input.balances.pending, kind: 'money', indent: true },
            { label: 'Available', value: input.balances.available, kind: 'money', indent: true },
            ...(ownerType === 'agency'
                ? [{ label: 'COD reserve', value: input.balances.reserve, kind: 'money' as const, indent: true }]
                : []),
            { label: 'Requested for payout', value: input.balances.requested, kind: 'money', indent: true },
        );
    }

    const notes = [...specific.notes];
    if (!input.balances) notes.push('Current balances could not be retrieved when this statement was generated.');
    notes.push(`All dates and times are in ${STATEMENT_TZ_LABEL}. Amounts are in ${specific.currency ?? 'XAF'}.`);

    return {
        ownerType,
        ownerId,
        ownerName: name,
        period: { from: period.from, to: period.to, timezoneLabel: STATEMENT_TZ_LABEL },
        generatedAt: input.now ?? new Date(),
        currency: specific.currency ?? 'XAF',
        summary,
        notes,
        sections: [...specific.sections, ...common.sections],
    };
}

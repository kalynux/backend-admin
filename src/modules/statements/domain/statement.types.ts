/**
 * The statement as DATA — what both renderers draw, and what `test:statements` asserts on.
 *
 * ── Why a document model between the reader and the file ─────────────────────
 * Two formats (owner decision O-3) must say the same thing. If each renderer walked the
 * database rows itself, the xlsx and the pdf would be two implementations of "what is on a
 * statement" and would drift the first time a column was added to one. So the builders emit
 * this, and the renderers only draw it: a column that exists here exists in both files.
 *
 * Record: `PRODUCTION-READINESS/ACCOUNT-STATEMENTS-AND-ANALYTICS-PLAN.md` (O-8: computed here,
 * mailed by jovi-mall).
 */

export type StatementOwnerType = 'vendor' | 'agency' | 'agent';
export type StatementFormat = 'xlsx' | 'pdf';

/** `Date` values are REAL instants; renderers convert them to the statement's zone. */
export type CellValue = string | number | Date | null;

export type ColumnKind = 'text' | 'money' | 'int' | 'datetime';

export interface StatementColumn {
    key: string;
    header: string;
    kind: ColumnKind;
    /** Relative width hint; the xlsx uses it as characters, the pdf as a proportion. */
    width?: number;
}

export type StatementRow = Record<string, CellValue>;

export interface StatementSection {
    key: string;
    title: string;
    /** One or two sentences a non-engineer can read: what a row is, and what is NOT here. */
    description: string;
    columns: StatementColumn[];
    rows: StatementRow[];
    /** Column keys whose sum is printed under the table. Money columns only. */
    totals?: string[];
    /** Wide detail tables are skipped by the PDF (they stay in the xlsx), with a pointer. */
    pdf?: 'include' | 'xlsx-only';
}

export interface SummaryLine {
    label: string;
    value: number | string | null;
    kind: 'money' | 'int' | 'text';
    /** A sub-line of the one above it (a deduction under the gross, say). */
    indent?: boolean;
}

export interface StatementDocument {
    ownerType: StatementOwnerType;
    ownerId: string;
    ownerName: string | null;
    period: { from: string; to: string; timezoneLabel: string };
    generatedAt: Date;
    currency: string;
    summary: SummaryLine[];
    /** Caveats printed on the summary page — every "not recorded" in the file is explained here. */
    notes: string[];
    sections: StatementSection[];
}

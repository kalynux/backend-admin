import ExcelJS from 'exceljs';
import { formatLocal, toWallClock } from '../domain/statement-period';
import { CellValue, StatementColumn, StatementDocument } from '../domain/statement.types';

/**
 * The workbook: a Summary sheet, then one sheet per section, every section present even when
 * empty — an absent sheet reads as "the platform forgot", an empty one with its description
 * reads as "nothing happened".
 *
 * Money is written as NUMBERS with a thousands format, never as preformatted strings, so the
 * account holder can sum and filter it; dates are real Excel dates in the statement's zone.
 */

const MONEY_FORMAT = '#,##0;[Red]-#,##0';
const DATE_FORMAT = 'yyyy-mm-dd hh:mm';

const OWNER_LABEL = { vendor: 'Vendor', agency: 'Delivery agency', agent: 'Delivery agent' } as const;

function cell(value: CellValue, _column: StatementColumn): ExcelJS.CellValue {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return toWallClock(value);
    return value;
}

/** Sheet names: ≤ 31 chars, no `[]:*?/\`. */
function sheetName(title: string, used: Set<string>): string {
    const base = title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim();
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base.slice(0, 28)} ${i}`;
    used.add(name);
    return name;
}

export async function renderXlsx(doc: StatementDocument): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'wi-mall';
    wb.created = doc.generatedAt;
    const used = new Set<string>();

    // ── Summary ────────────────────────────────────────────────────────────────
    const summary = wb.addWorksheet(sheetName('Summary', used));
    summary.columns = [{ width: 44 }, { width: 20 }];
    summary.addRow(['Account statement']).font = { bold: true, size: 14 };
    summary.addRow([OWNER_LABEL[doc.ownerType], doc.ownerName ?? doc.ownerId]);
    summary.addRow(['Account id', doc.ownerId]);
    summary.addRow(['Period', `${doc.period.from} to ${doc.period.to}`]);
    summary.addRow(['Generated', formatLocal(doc.generatedAt)]);
    summary.addRow(['Currency', doc.currency]);
    summary.addRow([]);
    for (const line of doc.summary) {
        const row = summary.addRow([`${line.indent ? '    ' : ''}${line.label}`, line.value ?? null]);
        if (line.kind === 'money') row.getCell(2).numFmt = MONEY_FORMAT;
        if (!line.indent && line.kind !== 'text') row.font = { bold: /net/i.test(line.label) };
    }
    summary.addRow([]);
    summary.addRow(['Notes']).font = { bold: true };
    for (const note of doc.notes) {
        const row = summary.addRow([note]);
        summary.mergeCells(row.number, 1, row.number, 2);
        row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
        row.height = Math.max(15, Math.ceil(note.length / 70) * 15);
    }

    // ── Sections ───────────────────────────────────────────────────────────────
    for (const section of doc.sections) {
        const sheet = wb.addWorksheet(sheetName(section.title, used));
        sheet.addRow([section.title]).font = { bold: true, size: 12 };
        const desc = sheet.addRow([section.description]);
        desc.getCell(1).alignment = { wrapText: true, vertical: 'top' };
        sheet.mergeCells(desc.number, 1, desc.number, Math.max(1, section.columns.length));
        desc.height = Math.max(15, Math.ceil(section.description.length / 120) * 15);
        sheet.addRow([]);

        const header = sheet.addRow(section.columns.map((c) => c.header));
        header.font = { bold: true };
        header.eachCell((c) => {
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEFF2' } };
            c.border = { bottom: { style: 'thin' } };
        });
        const headerRow = header.number;

        section.columns.forEach((c, i) => {
            sheet.getColumn(i + 1).width = Math.max(c.width ?? 14, c.header.length + 2);
            if (c.kind === 'money') sheet.getColumn(i + 1).numFmt = MONEY_FORMAT;
            if (c.kind === 'datetime') sheet.getColumn(i + 1).numFmt = DATE_FORMAT;
        });

        if (section.rows.length === 0) {
            sheet.addRow(['No entries in this period.']).font = { italic: true, color: { argb: 'FF6B7280' } };
            continue;
        }
        for (const row of section.rows) sheet.addRow(section.columns.map((c) => cell(row[c.key] ?? null, c)));

        if (section.totals?.length) {
            const totals = section.columns.map((c, i) => {
                if (i === 0) return 'Total';
                if (!section.totals!.includes(c.key)) return null;
                return section.rows.reduce((s, r) => s + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0);
            });
            const t = sheet.addRow(totals);
            t.font = { bold: true };
            t.eachCell((c) => (c.border = { top: { style: 'thin' } }));
        }
        sheet.views = [{ state: 'frozen', ySplit: headerRow }];
        sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: section.columns.length } };
    }

    return Buffer.from(await wb.xlsx.writeBuffer());
}

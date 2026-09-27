import PDFDocument from 'pdfkit';
import { formatLocal } from '../domain/statement-period';
import { CellValue, StatementColumn, StatementDocument, StatementSection } from '../domain/statement.types';

/**
 * The printable statement: a summary page, then every section marked for the PDF as a table.
 *
 * ── What the PDF leaves to the workbook, and says so ──────────────────────────
 * Sections marked `pdf: 'xlsx-only'` (the per-order detail, product lines, timeline) are
 * fifteen columns wide; truncated to a landscape page they would be unreadable rather than
 * printed. The PDF lists them by name under "In the Excel version", so an account holder
 * who needs them knows the Excel version exists.
 *
 * Built-in Helvetica is WinAnsi-encoded, so text is passed through `pdfSafe` — a U+2212 minus
 * sign or an arrow would otherwise print as garbage.
 */

const OWNER_LABEL = { vendor: 'Vendor', agency: 'Delivery agency', agent: 'Delivery agent' } as const;
const MARGIN = 36;
const FONT_SIZE = 7.5;
const ROW_HEIGHT = 12;

export function pdfSafe(text: string): string {
    return text
        .replace(/−/g, '-')
        .replace(/[←-⇿]/g, '->')
        // Printable ASCII, Latin-1 (U+00A0-U+00FF), and en/em dash, curly quotes, bullet, ellipsis, euro.
        // Escaped because the range starts at a no-break space, which ESLint rejects as irregular whitespace.
        .replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g, '?');
}

function money(value: number): string {
    const sign = value < 0 ? '-' : '';
    return sign + Math.abs(Math.round(value)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function display(value: CellValue | undefined, kind: StatementColumn['kind'] | 'money' | 'int' | 'text'): string {
    if (value === null || value === undefined || value === '') return '';
    if (value instanceof Date) return formatLocal(value);
    if (typeof value === 'number') return kind === 'money' ? money(value) : String(value);
    return pdfSafe(String(value));
}

export async function renderPdf(doc: StatementDocument): Promise<Buffer> {
    const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
        pdf.on('end', () => resolve(Buffer.concat(chunks)));
        pdf.on('error', reject);
    });

    const width = pdf.page.width - MARGIN * 2;

    // ── Summary page ───────────────────────────────────────────────────────────
    pdf.font('Helvetica-Bold').fontSize(16).text('Account statement');
    pdf.moveDown(0.3);
    pdf.font('Helvetica').fontSize(10);
    pdf.text(pdfSafe(`${OWNER_LABEL[doc.ownerType]}: ${doc.ownerName ?? doc.ownerId}`));
    pdf.text(`Account id: ${doc.ownerId}`);
    pdf.text(`Period: ${doc.period.from} to ${doc.period.to}`);
    pdf.text(`Generated: ${formatLocal(doc.generatedAt)} (${pdfSafe(doc.period.timezoneLabel)})`);
    pdf.text(`Currency: ${doc.currency}`);
    pdf.moveDown(0.8);

    const labelX = MARGIN;
    const valueX = MARGIN + 320;
    for (const line of doc.summary) {
        const y = pdf.y;
        const bold = !line.indent && line.kind !== 'text' && /net/i.test(line.label);
        pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
        pdf.text(pdfSafe(`${line.indent ? '     ' : ''}${line.label}`), labelX, y, { width: 300 });
        const v = line.value === null ? 'n/a' : display(line.value, line.kind);
        pdf.text(v, valueX, y, { width: 120, align: 'right' });
        pdf.moveDown(0.15);
    }

    pdf.moveDown(0.8);
    pdf.font('Helvetica-Bold').fontSize(10).text('Notes', labelX);
    pdf.font('Helvetica').fontSize(8.5);
    for (const note of doc.notes) pdf.text(pdfSafe(`• ${note}`), labelX, pdf.y, { width });

    const excelOnly = doc.sections.filter((s) => s.pdf === 'xlsx-only');
    if (excelOnly.length) {
        pdf.moveDown(0.5);
        pdf.font('Helvetica-Bold').fontSize(9).text('In the Excel version only', labelX);
        pdf.font('Helvetica').fontSize(8.5).text(pdfSafe(excelOnly.map((s) => s.title).join(', ')), labelX, pdf.y, { width });
    }

    // ── Sections ───────────────────────────────────────────────────────────────
    for (const section of doc.sections) {
        if (section.pdf === 'xlsx-only') continue;
        pdf.addPage();
        drawSection(pdf, section, width);
    }

    // Page numbers.
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        pdf.switchToPage(i);
        pdf.font('Helvetica').fontSize(7).fillColor('#6b7280');
        pdf.text(
            pdfSafe(`${doc.ownerName ?? doc.ownerId} · ${doc.period.from} to ${doc.period.to} · page ${i + 1} of ${range.count}`),
            MARGIN,
            pdf.page.height - MARGIN + 10,
            { width, align: 'right', lineBreak: false },
        );
        pdf.fillColor('black');
    }

    pdf.end();
    return done;
}

function drawSection(pdf: PDFKit.PDFDocument, section: StatementSection, width: number): void {
    pdf.font('Helvetica-Bold').fontSize(12).text(pdfSafe(section.title), MARGIN);
    pdf.font('Helvetica').fontSize(8.5).fillColor('#374151').text(pdfSafe(section.description), MARGIN, pdf.y, { width });
    pdf.fillColor('black').moveDown(0.5);

    const weights = section.columns.map((c) => c.width ?? 14);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const widths = weights.map((w) => (w / totalWeight) * width);
    const bottom = pdf.page.height - MARGIN - 14;

    const drawHeader = () => {
        let x = MARGIN;
        const y = pdf.y;
        pdf.rect(MARGIN, y - 2, width, ROW_HEIGHT + 2).fill('#edeff2').fillColor('black');
        pdf.font('Helvetica-Bold').fontSize(FONT_SIZE);
        section.columns.forEach((c, i) => {
            pdf.text(pdfSafe(c.header), x + 2, y, {
                width: widths[i] - 4,
                align: c.kind === 'money' || c.kind === 'int' ? 'right' : 'left',
                lineBreak: false,
                ellipsis: true,
            });
            x += widths[i];
        });
        pdf.y = y + ROW_HEIGHT + 2;
    };

    const drawRow = (values: string[], bold = false) => {
        if (pdf.y + ROW_HEIGHT > bottom) {
            pdf.addPage();
            drawHeader();
        }
        let x = MARGIN;
        const y = pdf.y;
        pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT_SIZE);
        section.columns.forEach((c, i) => {
            pdf.text(values[i], x + 2, y, {
                width: widths[i] - 4,
                align: c.kind === 'money' || c.kind === 'int' ? 'right' : 'left',
                lineBreak: false,
                ellipsis: true,
            });
            x += widths[i];
        });
        pdf.y = y + ROW_HEIGHT;
    };

    drawHeader();
    if (section.rows.length === 0) {
        pdf.font('Helvetica-Oblique').fontSize(8).text('No entries in this period.', MARGIN);
        return;
    }
    for (const row of section.rows) drawRow(section.columns.map((c) => display(row[c.key], c.kind)));

    if (section.totals?.length) {
        const totals = section.columns.map((c, i) => {
            if (i === 0) return 'Total';
            if (!section.totals!.includes(c.key)) return '';
            return money(section.rows.reduce((s, r) => s + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0));
        });
        pdf.moveTo(MARGIN, pdf.y).lineTo(MARGIN + width, pdf.y).stroke();
        pdf.y += 2;
        drawRow(totals, true);
    }
}

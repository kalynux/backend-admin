/**
 * A minimal Prometheus text-exposition parser.
 *
 * ── Why parse rather than pass through ────────────────────────────────────────
 * Three reasons, in weight order:
 *
 *  1. `/api/v1` is JSON throughout, via `sendSuccess`. A single `text/plain; version=0.0.4`
 *     response would break the envelope, the error shape and the dashboard's fetch layer.
 *  2. A passthrough is an **unbounded** body buffered and forwarded with no cap.
 *  3. Parsing lets us apply an explicit allowlist — ADR-014 D-3's "an explicit projection, not a
 *     dependency's internal shape as our API", applied a second time. **The trade, stated:** a
 *     new geo-tracker instrument does not appear here until the allowlist learns about it. That
 *     is the price of not letting another service's registry become this service's wire contract.
 *
 * Pure and DB-free, so `test:devtools` drives it from a literal exposition.
 */

export interface PromSample {
    name: string;
    labels: Record<string, string>;
    value: number;
}

export interface PromMetric {
    name: string;
    help: string | null;
    type: string | null;
    samples: PromSample[];
}

export interface ParsedPromText {
    metrics: PromMetric[];
    truncated: boolean;
    ignored: number;
}

/** 256 KB. geo-tracker exports ~16 instruments; anything near this is a bug or an attack. */
export const PROM_TEXT_MAX_BYTES = 256 * 1024;

/**
 * Split a label block on commas that are NOT inside a quoted value.
 *
 * `route="/a,/b"` is one label, and a naive `split(',')` turns it into two malformed ones. This
 * is the case the test pins, because it is the one that looks fine until a label contains a
 * comma in production.
 */
function splitLabels(block: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    let escaped = false;

    for (const char of block) {
        if (escaped) { current += char; escaped = false; continue; }
        if (char === '\\') { current += char; escaped = true; continue; }
        if (char === '"') { inQuotes = !inQuotes; current += char; continue; }
        if (char === ',' && !inQuotes) { parts.push(current); current = ''; continue; }
        current += char;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

function parseLabels(block: string | undefined): Record<string, string> {
    if (!block) return {};
    const labels: Record<string, string> = {};
    for (const part of splitLabels(block)) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        if (!key) continue;
        labels[key] = raw.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    return labels;
}

/**
 * Parse an exposition, keeping only metrics named in `allow`.
 *
 * Never throws: a malformed line is counted in `ignored` and skipped. A parser that throws on one
 * bad line would turn a partially-garbled scrape into no observability at all, at precisely the
 * moment observability is what you want.
 */
export function parsePromText(text: string, allow: readonly string[]): ParsedPromText {
    const truncated = Buffer.byteLength(text, 'utf8') > PROM_TEXT_MAX_BYTES;
    const body = truncated ? text.slice(0, PROM_TEXT_MAX_BYTES) : text;
    const allowed = new Set(allow);

    const byName = new Map<string, PromMetric>();
    let ignored = 0;

    const ensure = (name: string): PromMetric => {
        let metric = byName.get(name);
        if (!metric) {
            metric = { name, help: null, type: null, samples: [] };
            byName.set(name, metric);
        }
        return metric;
    };

    /** A histogram's `_bucket`/`_sum`/`_count` belong to their base instrument. */
    const baseName = (name: string): string =>
        name.replace(/_(bucket|sum|count)$/, '');

    for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('#')) {
            const meta = /^#\s+(HELP|TYPE)\s+(\S+)\s+(.*)$/.exec(trimmed);
            if (!meta) continue;
            const [, kind, name, rest] = meta;
            if (!allowed.has(name)) continue;
            const metric = ensure(name);
            if (kind === 'HELP') metric.help = rest;
            else metric.type = rest.trim();
            continue;
        }

        const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(.+)$/.exec(trimmed);
        if (!sample) { ignored += 1; continue; }

        const [, rawName, , labelBlock, rawValue] = sample;

        /**
         * The value is validated BEFORE the allowlist filter, and the order matters.
         *
         * `this line is malformed` satisfies the sample regex — `this` parses as a metric name
         * and the rest as a value — so filtering by allowlist first would `continue` past it and
         * `ignored` would stay 0. That makes `ignored` mean "unparseable AND allowlisted", which
         * is not what an operator reads it as. Counting first makes it mean what it says:
         * lines this parser could not make sense of.
         *
         * `+Inf` is a legal bucket bound and a legal value; `NaN` appears on empty summaries.
         */
        const valueText = rawValue.trim();
        const value = valueText === '+Inf' ? Number.POSITIVE_INFINITY
            : valueText === '-Inf' ? Number.NEGATIVE_INFINITY
                : Number(valueText);
        if (Number.isNaN(value) && valueText !== 'NaN') { ignored += 1; continue; }

        const owner = allowed.has(rawName) ? rawName : baseName(rawName);
        if (!allowed.has(owner)) continue;

        ensure(owner).samples.push({ name: rawName, labels: parseLabels(labelBlock), value });
    }

    return { metrics: [...byName.values()], truncated, ignored };
}

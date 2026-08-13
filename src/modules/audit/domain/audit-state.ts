import { env } from '../../../config/env';
import { REDACTED_PATHS } from '../../../core/logging/logger';

/**
 * What an audit row is allowed to remember about a change.
 *
 * Three rules, in priority order, and the first is the one that keeps this collection
 * from becoming a liability of its own.
 *
 * 1. **Changed fields only, never whole documents.** A `setTier` row holds
 *    `before: { tier: 3 }`, `after: { tier: 2 }` — not the account. This is ADR-005 D-8's
 *    named-field rule applied to storage: the projection is the first lock, naming each
 *    field is the second, and the second is the one that survives somebody widening the
 *    first for a new screen. Callers name what changed; this file does not go looking.
 * 2. **Credential shapes cannot be present.** Enforced here rather than trusted to
 *    callers, because "the caller will remember" is exactly the assumption that puts a
 *    password hash in a log.
 * 3. **Bounded.** Mongo's 16 MB limit is not the binding constraint — the working set
 *    and the export size are. Over the cap, the value is replaced by a summary and the
 *    row says so; nothing is ever dropped silently.
 */

/**
 * The field names that must never appear in a stored value, derived from the logger's
 * redaction list rather than retyped.
 *
 * `REDACTED_PATHS` is pino-shaped (`*.password`, `req.headers.cookie`); the leaf name is
 * what matters here. Deriving means the two cannot drift — and `test-foundation.ts`
 * already asserts that list stays complete, so this inherits that guarantee instead of
 * needing its own. Maintaining a second copy is the mistake this codebase documents
 * repeatedly: two lists that must agree, and nothing making them.
 */
function buildSensitiveFieldNames(): ReadonlySet<string> {
    const names = new Set<string>();

    for (const path of REDACTED_PATHS) {
        const leaf = path.split('.').pop() ?? path;
        // `req.headers["x-service-token"]` → `x-service-token`
        names.add(leaf.replace(/^\["?|"?\]$/g, '').toLowerCase());
    }

    // A few shapes the logger has no reason to carry but an audit payload might. The
    // first three matter most: this service hands out generated passwords in response
    // bodies, and those bodies are exactly what a careless caller would pass as `after`.
    for (const extra of ['onetimepassword', 'currentpassword', 'newpassword', 'pan', 'cvv']) {
        names.add(extra);
    }

    return names;
}

export const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = buildSensitiveFieldNames();

export const REDACTED_MARKER = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
    return SENSITIVE_FIELD_NAMES.has(key.toLowerCase());
}

/**
 * Deep-copy a value, replacing credential-shaped fields at any depth.
 *
 * Cycles are tolerated rather than thrown on: a caller passing a Mongoose document by
 * accident must produce a truncated row, not a 500 that refuses an administrator's action
 * — remember that under fail-closed, throwing here would cancel the action being audited.
 */
function redact(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return null;

    if (value instanceof Date) return value.toISOString();
    if (typeof value !== 'object') return value;

    if (seen.has(value as object)) return '[CIRCULAR]';
    seen.add(value as object);

    if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        output[key] = isSensitiveKey(key) ? REDACTED_MARKER : redact(entry, seen);
    }
    return output;
}

export interface SanitisedState {
    value: Record<string, unknown> | null;
    truncated: boolean;
}

/**
 * Redact, then cap.
 *
 * The cap replaces the value with `{ truncated, bytes, keys }` — the key names survive
 * because knowing *which* fields changed is most of the forensic value, and they are the
 * part that is certainly small.
 */
export function sanitiseState(input: unknown, maxBytes?: number): SanitisedState {
    if (input === null || input === undefined) return { value: null, truncated: false };

    const limit = maxBytes ?? env().ADMIN_AUDIT_MAX_STATE_BYTES;
    const redacted = redact(input, new WeakSet()) as Record<string, unknown>;

    if (typeof redacted !== 'object' || Array.isArray(redacted)) {
        return { value: { value: redacted }, truncated: false };
    }

    const bytes = Buffer.byteLength(JSON.stringify(redacted) ?? '', 'utf8');
    if (bytes <= limit) return { value: redacted, truncated: false };

    return {
        value: { truncated: true, bytes, keys: Object.keys(redacted).slice(0, 50) },
        truncated: true,
    };
}

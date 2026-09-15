import { SENSITIVE_FIELD_NAMES } from '../../modules/audit/domain/audit-state';
import { ERROR_CATEGORIES, ErrorCategory } from './error-category';

/**
 * What of an error's `details` a CALLER is allowed to see (Phase 16).
 *
 * Mirrors `jovi-mall/src/core/error-detail-policy.ts`. The rule is the same and it is worth
 * restating: filtering happens at the BOUNDARY, keyed on category, never at the throw site.
 *
 * ── What this closes in THIS service ──────────────────────────────────────────
 * The global handler's only `NODE_ENV` gate was on the unknown-error branch, so a 5xx
 * `AppError` sent its message and details verbatim in production. Three request-time 500s
 * in `dual-control/domain/approval.service.ts` carry prose like
 * `Approval request names the unknown action "…"`, and the nineteen boot-time assertions
 * carry `{ problemCount, problems: string[] }` — a full internal diagnostic. Those never
 * reach a client today only because the process exits first, which is not a boundary.
 *
 * It also bounds what `platform.client.ts` forwards. `toAppError` spreads jovi-mall's
 * `error.details` wholesale into ours; running the result through here means a foreign
 * payload cannot arrive unbounded even from an older jovi-mall build that has not yet
 * filtered on its own side.
 *
 * Not environment-gated: `internal` and `external_service` are masked in development
 * exactly as in production, and `test:contract` asserts the two produce identical output.
 */

/** Serialised ceiling for anything that reaches a caller. `details` is not a payload channel. */
export const MAX_DETAILS_BYTES = 8 * 1024;

/** Nesting ceiling. */
export const MAX_DETAILS_DEPTH = 4;

/**
 * Keys an `authorization` failure may carry, and no others.
 *
 * `authorize.middleware.ts` already sends only `{ required, mode }` — deliberately, and its
 * comment names jovi-mall's `{ required, actual }` as the leak it is avoiding. This
 * allowlist makes that a boundary rule rather than a habit of one call site.
 */
const AUTHORIZATION_DETAIL_KEYS: ReadonlySet<string> = Object.freeze(
    new Set(['required', 'requiredany', 'mode', 'resource', 'action', 'hint']),
);

/**
 * Keys a `rate_limit` refusal may carry.
 *
 * ⚠ `platformcode` was ADDED on 2026-09-15 (BR-025 § 2), reversing the position `errors.md`
 * recorded on 2026-09-08. It qualifies on the same one test the `external_service` branch
 * below states, and on the identical key: **it carries a PUBLISHED error code, not internal
 * narrative.** Nothing about a 429 makes that code more sensitive than it already is at 502.
 *
 * What the omission cost is the argument for it. jovi-mall raises two 429s on the phone flow —
 * `PHONE_VERIFICATION_RESEND_TOO_SOON` (wait; the code already in their hand still works) and
 * `PHONE_VERIFICATION_TOO_MANY_ATTEMPTS` (that code has been DESTROYED — request a new one) —
 * and the second carries no `details` at all, so without the code the two were
 * indistinguishable. **The remedies are opposite**, and guessing between them is not
 * symmetric: telling somebody to wait when their code is already dead leaves them at a form
 * that cannot succeed.
 *
 * ⚠ **This is not phone-specific.** It is every delegated 429 on the service; the phone flow is
 * merely where two refusals first wanted contradictory advice.
 *
 * ⚠ **`authorization` was DELIBERATELY NOT given the same treatment.** A 403 is the one place
 * where naming what refused tells a caller what to go after next, and no screen is broken for
 * want of it. That asymmetry is the decision rather than an oversight — see `errors.md`
 * § "What travels in `details`".
 */
const RATE_LIMIT_DETAIL_KEYS: ReadonlySet<string> = Object.freeze(
    new Set(['retryafterseconds', 'limit', 'windowseconds', 'platformcode']),
);

/**
 * Key names carrying an internal narrative rather than a fact about the caller's request.
 *
 * Dropped from EVERY category, including the client-safe ones. Unioned with
 * `SENSITIVE_FIELD_NAMES` from the audit redactor rather than restating it — that set is
 * already derived from `REDACTED_PATHS`, so there is one list and it cannot drift.
 *
 * `problems` and `problemcount` are here because they are the boot assertions' payload:
 * a list of internal inconsistencies naming permissions, actions and route paths.
 */
const INTERNAL_DETAIL_KEYS: ReadonlySet<string> = Object.freeze(
    new Set([
        'cause',
        'causemessage',
        'stack',
        'originalerror',
        'originalcode',
        'originalmessage',
        'upstream',
        'upstreamerror',
        'upstreambody',
        'response',
        'responsebody',
        'rawresponse',
        'raw',
        'problems',
        'problemcount',
        'sql',
        'query',
        'command',
        'dsn',
        'connectionstring',
        'env',
        'config',
        'hostname',
    ]),
);

function normaliseKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDroppedKey(key: string): boolean {
    const normalised = normaliseKey(key);
    return INTERNAL_DETAIL_KEYS.has(normalised) || SENSITIVE_FIELD_NAMES.has(normalised);
}

function scrubValue(value: unknown, depth: number): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DETAILS_DEPTH) return '[TRUNCATED]';

    if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (isDroppedKey(key)) continue;
        output[key] = scrubValue(entry, depth + 1);
    }
    return output;
}

function pickKeys(
    details: Record<string, unknown>,
    allowed: ReadonlySet<string>,
): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
        if (!allowed.has(normaliseKey(key))) continue;
        output[key] = scrubValue(value, 1);
    }
    return output;
}

/**
 * The caller's copy of `details`, or `undefined` when there is none to give.
 *
 * `undefined` rather than `{}` or `null` — ADR-005 D-9 requires `details` to be omitted
 * entirely when absent, and `test:contract` asserts `!('details' in error)`.
 *
 * `platformCode`/`platformStatus` (jovi-mall) and `upstreamCode`/`upstreamStatus`
 * (geo-tracker) are preserved through the scrub on purpose: they are the dashboard's only
 * handle on WHY a delegated call was refused, and none is internal to us — each code is a
 * published contract and each status was already sent. See the branch below for the test a
 * key must pass before it joins them.
 */
export function projectDetails(
    category: ErrorCategory,
    details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    if (details === undefined || details === null) return undefined;

    if (category === ERROR_CATEGORIES.INTERNAL || category === ERROR_CATEGORIES.EXTERNAL_SERVICE) {
        // The one exception to "nothing survives": a delegated 5xx keeps the fields that say
        // WHERE it failed. Without them a dashboard cannot tell "jovi-mall is down" from
        // "wi-admin is down", and both are 502s from the caller's side.
        //
        // TWO PAIRS, ONE PER UPSTREAM, AND THEY ARE DELIBERATELY NOT INTERCHANGEABLE.
        // `platformCode`/`platformStatus` are jovi-mall's, everywhere in this service — the
        // audit table stores the first as `platform_code` and `platform.client.ts` is its
        // only producer. `upstreamCode`/`upstreamStatus` are geo-tracker's, attached by
        // `agents/domain/tracking-disclosure.ts`. Collapsing the second pair onto the first
        // would make a geo-tracker refusal read as a jovi-mall one, which is the exact
        // confusion this allowlist exists to prevent.
        //
        // ⚠ This is an ALLOWLIST, and adding a key to it is a disclosure decision. All four
        // qualify on one test and nothing here should be added that fails it: each carries a
        // PUBLISHED error code or an HTTP status the caller was already sent. Neither is
        // internal narrative. An upstream's `message`, `body` or `stack` never qualifies —
        // `upstream`, `upstreamBody` and `upstreamError` are on the deny-list above for that
        // reason, and the near-identical names are not an oversight.
        const platformCode = details.platformCode;
        const platformStatus = details.platformStatus;
        const upstreamCode = details.upstreamCode;
        const upstreamStatus = details.upstreamStatus;
        const projectedUpstream = {
            ...(typeof platformCode === 'string' && { platformCode }),
            ...(typeof platformStatus === 'number' && { platformStatus }),
            ...(typeof upstreamCode === 'string' && { upstreamCode }),
            ...(typeof upstreamStatus === 'number' && { upstreamStatus }),
        };
        if (Object.keys(projectedUpstream).length > 0) return projectedUpstream;
        return undefined;
    }

    let projected: Record<string, unknown>;
    if (category === ERROR_CATEGORIES.AUTHORIZATION) {
        projected = pickKeys(details, AUTHORIZATION_DETAIL_KEYS);
    } else if (category === ERROR_CATEGORIES.RATE_LIMIT) {
        projected = pickKeys(details, RATE_LIMIT_DETAIL_KEYS);
    } else {
        projected = scrubValue(details, 0) as Record<string, unknown>;
    }

    if (Object.keys(projected).length === 0) return undefined;

    let serialised: string;
    try {
        serialised = JSON.stringify(projected);
    } catch {
        return { truncated: true };
    }

    if (serialised.length > MAX_DETAILS_BYTES) {
        return { truncated: true, bytes: serialised.length };
    }

    return projected;
}

/**
 * The caller's copy of an error `message`.
 *
 * For the masked categories the registry's default for that code is used — never the thrown
 * message. `test:contract` already asserts every code renders a non-generic default, so
 * this always has something better than the fallback to reach for.
 */
export function projectMessage(
    category: ErrorCategory,
    thrownMessage: string,
    registryDefault: string | undefined,
): string {
    if (category === ERROR_CATEGORIES.INTERNAL || category === ERROR_CATEGORIES.EXTERNAL_SERVICE) {
        return registryDefault ?? 'Something went wrong';
    }
    return thrownMessage;
}

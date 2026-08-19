import pino, { Logger } from 'pino';

/**
 * Structured logging with mandatory redaction.
 *
 * This is a deliberate divergence from jovi-mall, which logs with `console.*`. That
 * choice is exactly how a **refresh token** ended up written to stdout on every silent
 * refresh (`auth.middleware.ts`, patched in Phase 0.5). Redaction there was a rule every
 * author had to remember; here it is a property of the logger.
 *
 * `REDACTED_PATHS` is the security boundary of this file. Adding a credential-shaped
 * field to a logged object without adding it here reintroduces that defect — the
 * wildcard patterns below cover the common shapes, and `scripts/test/test-foundation.ts`
 * asserts the list stays complete.
 */

export const REDACTED_PATHS = [
    // Request/response headers that carry credentials verbatim
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-service-token"]',
    'res.headers["set-cookie"]',
    // Credential-shaped fields anywhere in a logged payload, at any depth
    '*.password',
    '*.passwordHash',
    '*.password_hash',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.secret',
    '*.serviceToken',
    '*.totpSecret',
    '*.mfaSecret',
    '*.apiKey',
] as const;

let instance: Logger | null = null;

/**
 * The pretty-printing transport — configured only when `pino-pretty` can actually
 * be resolved.
 *
 * `pino-pretty` is a devDependency and should STAY one: a colourising printer has
 * no business in a production image. But two facts collide without this guard, and
 * the result is a boot crash rather than a missing colour.
 *
 *   1. The runtime image is built with `npm ci --omit=dev`, so the module is absent.
 *   2. That image is legitimately run at `NODE_ENV=development` — the workspace
 *      compose stack does exactly that, because `cookie.config.ts` sets
 *      `secure: true` in production and a Secure cookie is never sent over
 *      http://localhost, so every login against the local stack would fail to stick.
 *
 * pino resolves a transport target lazily, at construction. A missing one aborts
 * with `unable to determine transport target for "pino-pretty"` and nothing else —
 * no stack, no mention of NODE_ENV — and `restart: unless-stopped` turns that into
 * a crash loop. Found by plan step 2.B.4, on the first `docker compose up`.
 *
 * Degrading to structured JSON is always the right trade: losing colour is not a
 * reason for a service to fail to start.
 */
function prettyTransport(): Record<string, never> | { transport: { target: string; options: object } } {
    if (process.env.NODE_ENV === 'production') return {};

    try {
        require.resolve('pino-pretty');
    } catch {
        return {};
    }

    return {
        transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
    };
}

/**
 * The root logger. Built lazily so `config/env.ts` can be imported and validated first —
 * a config failure should print a plain, readable message, not arrive pre-formatted as
 * JSON from a logger that may itself be misconfigured.
 */
export function logger(): Logger {
    if (instance) return instance;

    const level = process.env.LOG_LEVEL || 'info';

    instance = pino({
        level,
        redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
        base: { service: 'wi-admin' },
        formatters: {
            // Emit `"level":"info"` rather than pino's numeric default, so logs are
            // readable without a decoder ring in whatever aggregator receives them.
            level: (label) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        ...prettyTransport(),
    });

    return instance;
}

/**
 * A logger bound to one request's correlation id.
 *
 * Phase 3's audit writer takes one of these, so every audit row and every log line for
 * the same admin action share a `requestId` without anyone threading it by hand.
 */
export function requestLogger(requestId: string): Logger {
    return logger().child({ requestId });
}

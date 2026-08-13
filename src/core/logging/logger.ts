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
 * The root logger. Built lazily so `config/env.ts` can be imported and validated first —
 * a config failure should print a plain, readable message, not arrive pre-formatted as
 * JSON from a logger that may itself be misconfigured.
 */
export function logger(): Logger {
    if (instance) return instance;

    const isProduction = process.env.NODE_ENV === 'production';
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
        ...(isProduction
            ? {}
            : {
                transport: {
                    target: 'pino-pretty',
                    options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
                },
            }),
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

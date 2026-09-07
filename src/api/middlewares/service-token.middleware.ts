import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';
import { env } from '../../config/env';

/**
 * The credential check for the ONE inbound service caller this service has (ADR-022).
 *
 * ── Why this exists at all, and what it is not ────────────────────────────────
 * Every other route on wi-admin answers to an administrator: a session cookie or a bearer
 * token that resolves to a row in `admin_accounts`, graded by tier. The n8n automation
 * layer has no such identity and must never be given one — minting an administrator
 * account for a workflow would put a machine inside the tier model, where every
 * permission, every audit actor and every escalation rule assumes a person.
 *
 * So this is deliberately NOT a branch inside `authenticate.middleware.ts`. It is a
 * separate file with a separate guard, for the reason geo-tracker keeps `serviceaccess`
 * out of `authz`: a caller path with a service escape hatch is two policies sharing one
 * function, and nobody reading it can say which one refused a request.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────────
 * It sets no `req.admin`. Nothing downstream may treat a service caller as a person —
 * an audit row with a machine in the actor field would be a lie, and `requireCsrfToken`
 * passes an identity-less request through precisely because there is no cookie to forge.
 *
 * ── Inert when unconfigured ───────────────────────────────────────────────────
 * No token means this deployment has no automation layer, which is a supported posture.
 * It answers 503 rather than 401: the difference matters to an operator, because 401 says
 * "your credential is wrong" and sends them to rotate a secret that was never required.
 */

const SERVICE_TOKEN_HEADER = 'x-automation-token';

/**
 * Constant-time comparison, the same shape `csrf.middleware.ts` uses and for the same
 * reason: `===` leaks how many leading characters matched. `timingSafeEqual` throws on a
 * length mismatch, so length is compared first — that leaks only the length, which an
 * attacker can obtain by other means anyway.
 */
function tokensMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export function isAutomationDoorConfigured(): boolean {
    return Boolean(env().AUTOMATION_REPORT_TOKEN);
}

export const requireServiceToken = (req: Request, _res: Response, next: NextFunction): void => {
    const expected = env().AUTOMATION_REPORT_TOKEN;

    if (!expected) {
        return next(createAppError(ERROR_CODES.AUTOMATION_DOOR_UNCONFIGURED, 503));
    }

    const presented = req.headers[SERVICE_TOKEN_HEADER];

    // One code for missing, malformed and wrong — see the code's docstring. A prober must
    // not be able to tell which half of the credential it got right.
    if (typeof presented !== 'string' || !presented || !tokensMatch(presented, expected)) {
        return next(createAppError(ERROR_CODES.AUTOMATION_REPORT_TOKEN_INVALID, 401));
    }

    next();
};

export { SERVICE_TOKEN_HEADER };

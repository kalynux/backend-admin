import { Request } from 'express';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';

/**
 * The typed administrator identity — what every authenticated handler receives.
 *
 * `req.admin`, deliberately NOT `req.auth`. jovi-mall's `req.auth` is
 * `{ user, role, role_entity }` with a loosely-typed `role_entity: any`; reusing the
 * property name here would invite muscle memory to reach for fields that do not exist,
 * and `any` is exactly the looseness this replaces.
 */

/**
 * Administrator level — an administrator's ENTIRE authorization state.
 *
 * There are no per-admin permission overrides, by decision: a level's capabilities are
 * fixed and only the level changes. That dropped three collections from the original
 * design and it still holds.
 *
 *   1 Developer — highest privilege
 *   2 Admin     — operational/management
 *   3 Support   — support-oriented
 *
 * **Lower number = more privilege.** Worth saying out loud, because `tier > actor.tier`
 * reading as "less privileged than the actor" is the source of every off-by-one here.
 *
 * A level is not itself the authorization unit: it GRANTS a set of named permissions
 * (`tier-grants.ts`), and a route declares the permission it needs rather than a level.
 * See ADR-003 for why — briefly, "never rely solely on tier checks when a resource-specific
 * permission is required" is not expressible as one number per route.
 */
export type AdminTier = 1 | 2 | 3;

export const ADMIN_TIERS: readonly AdminTier[] = [1, 2, 3] as const;

export const ADMIN_TIER_LABELS: Readonly<Record<AdminTier, string>> = Object.freeze({
    1: 'Developer',
    2: 'Admin',
    3: 'Support',
});

export function isAdminTier(value: unknown): value is AdminTier {
    return value === 1 || value === 2 || value === 3;
}

/**
 * An administrator account's lifecycle state — and note that `pending` is not a flavour of
 * `suspended`, it is the state every account starts in.
 *
 *   `pending`    Created, can SIGN IN, and can reach nothing but their own account.
 *                A new administrator is an unverified person until a Developer has read
 *                their employee record and said otherwise (ADR-023 D-1). They exist so they
 *                can enrol two-factor, upload their identity evidence and fill in the record
 *                that gets them activated — that, and nothing else.
 *   `active`     Activated by a tier-1 Developer. Permissions apply normally.
 *   `suspended`  Access withdrawn. Sessions are destroyed on the next request.
 *
 * ⚠ **The ORDER of this union and of `ADMIN_STATUSES` is a contract.** It is the Mongoose
 * enum, the dashboard's filter vocabulary and the `z.enum` on the directory query. Adding a
 * value is additive; reordering is not, and neither is renaming one.
 *
 * ⚠ **`pending` and `suspended` are not interchangeable and must never be merged.** They
 * answer opposite questions — "has this person been let in yet" versus "has this person been
 * shut out" — and a directory that cannot tell them apart cannot answer either. They also
 * behave differently at the gate: a suspended administrator's sessions are destroyed and the
 * request is refused, while a pending one keeps their session and is refused only the routes
 * outside `ONBOARDING_ROUTE_ALLOWLIST`.
 */
export type AdminStatus = 'pending' | 'active' | 'suspended';

export const ADMIN_STATUSES: readonly AdminStatus[] = ['pending', 'active', 'suspended'] as const;

/** How a request proved its identity. The CSRF guard depends on this distinction. */
export type AdminAuthMethod = 'cookie' | 'bearer';

export interface AdminIdentity {
    adminId: string;
    /** The session this request belongs to. Revoking it invalidates the token immediately. */
    sessionId: string;
    email: string;
    displayName: string;
    tier: AdminTier;
    status: AdminStatus;
    mfaEnrolled: boolean;
    /**
     * True when this session was established with a password ALONE by an admin whose
     * tier requires two-factor. Such a session may reach the MFA enrolment endpoints and
     * nothing else — `requireAdmin` rejects it everywhere else.
     */
    pendingMfaEnrolment: boolean;
    /**
     * True when this administrator's account is still `pending` — created, able to sign in,
     * and not yet activated by a Developer.
     *
     * Such a session reaches only `ONBOARDING_ROUTE_ALLOWLIST` and nothing else;
     * `requireAdmin` refuses it everywhere outside that set, for the same reason and by the
     * same mechanism as `pendingMfaEnrolment` above. Handlers should not branch on this — the
     * gate has already decided — but a DTO may surface it so the dashboard can render the
     * onboarding screen instead of a dashboard the caller cannot load.
     */
    pendingActivation: boolean;
    /** When the session was established — not when this request arrived. */
    authenticatedAt: Date;
    /** The session's ABSOLUTE deadline; idle expiry is enforced separately by the Redis TTL. */
    sessionExpiresAt: Date;
    authMethod: AdminAuthMethod;
    ip: string | null;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            admin?: AdminIdentity;
        }
    }
}

/**
 * Narrow `req.admin` for handlers behind `requireAdmin`.
 *
 * Exists so no handler writes `req.admin!`. The non-null assertion is a promise the
 * compiler cannot check, and it silently becomes false the first time someone mounts a
 * route without the guard — this throws honestly instead of dereferencing undefined.
 */
export function requireAdminIdentity(req: Request): AdminIdentity {
    if (!req.admin) {
        throw createAppError(
            ERROR_CODES.ADMIN_AUTH_MISSING_TOKEN,
            401,
            'No administrator identity on this request — is requireAdmin mounted on this route?',
        );
    }
    return req.admin;
}

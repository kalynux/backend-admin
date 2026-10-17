import { Request, Response } from 'express';
import { actorContextOf } from '../../audit/domain/audit-context';
import { asyncHandler } from '../../../core/http/async-handler';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { toPageMeta } from '../../../core/http/list-query';
import { sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { toAuditEntryDto } from '../../audit/domain/audit.dto';
import { AuditRepository } from '../../audit/repositories/audit.repository';
import { ListAuditQuery } from '../../audit/validators/audit.validator';
import * as gateway from '../gateways/user.gateway';
import {
    MissingRoleProfile,
    RoleProfile,
    ProfileOwner,
    findProfileOwners,
    findRoleProfiles,
    idMatchKinds,
    isWholeId,
} from '../repositories/role-profile.read.repository';
import { UserReadModel, UserReadRepository } from '../repositories/user.read.repository';
import { RoleClosureReadRepository, toRoleClosureDto } from '../repositories/role-closure.read.repository';
import {
    LiftUserCodRestrictionBody,
    ListUserActivityQuery,
    RequestRoleClosureBody,
    ResetBotMemoryBody,
    RestrictUserCodBody,
    SearchUsersQuery,
    SendCredentialBody,
    SuspendUserBody,
    UpdateUserBody,
} from '../validators/user.validator';

/**
 * `/api/v1/users` — platform user management.
 *
 * The domain where both halves of ADR-004 meet in one module: the list, the detail and the
 * activity feed are **direct reads**, and every write is **delegated**. The reason is not
 * symmetry for its own sake — a suspension is only meaningful because jovi-mall's
 * `requireAuth`, `login` and refresh rotation refuse a non-active account, and a login
 * identifier is only safe because that service owns its uniqueness index and its format
 * rule. Reads protect none of that, so they go straight to the collection.
 *
 * What this surface deliberately does NOT offer:
 *
 *  - **role changes.** `users.roles.manage` exists in the catalog and no route uses it.
 *    Adding a role provisions a role entity (a Store, a Magazin) and removing one strands
 *    every record that entity owns — there is no code path in jovi-mall that removes a
 *    role, and inventing the semantics from the admin side is how a vendor's products end
 *    up belonging to nobody.
 *  - **forced sign-out and password reset.** jovi-mall issues stateless JWTs with no
 *    session store, so there is nothing to revoke, and it has no administrator-initiated
 *    password flow. Suspension covers the need those endpoints would have served: it
 *    blocks the next request on every device. See the notes on those two permissions in
 *    `permission.catalog.ts`.
 */

const users = new UserReadRepository();
const closureRequests = new RoleClosureReadRepository();
const audit = new AuditRepository();

interface UserDto {
    id: string;
    email: string | null;
    phone: string | null;
    roles: string[];
    status: string;
    suspension: {
        at: string | null;
        reason: string | null;
        by: { id: string | null; source: string; name: string | null } | null;
    } | null;
    /**
     * When the account owner closed it (jovi-mall's ADR-A02). Null unless `status` is
     * `closed`, and paired with it for the same reason `suspension` is paired with
     * `suspended`: a date rendered without its status reads as a state the account is not in.
     */
    closedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

interface UserDetailDto extends UserDto {
    /** One entry per role the user holds, in `roles` order. */
    profiles: (RoleProfile | MissingRoleProfile)[];
}

/**
 * Named-field mapping, not a spread.
 *
 * The projection already excludes everything sensitive; building the DTO by naming fields
 * is the second of the two locks, and the one that survives somebody widening the
 * projection for a new screen.
 */
function toUserDto(user: UserReadModel): UserDto {
    return {
        id: user._id.toString(),
        email: user.login_email ?? null,
        phone: user.login_phone ?? null,
        roles: user.roles ?? [],
        status: user.status,
        // Present only while suspended. An active account carrying a stale reason would
        // read as suspended on any screen that renders the block without checking status
        // first — jovi-mall clears the columns on reinstatement, and this mirrors that
        // rather than trusting it.
        suspension:
            user.status === 'suspended'
                ? {
                      at: toIso(user.suspended_at),
                      reason: user.suspended_reason ?? null,
                      by: {
                          id: user.suspended_by_user_id?.toString() ?? null,
                          source: user.suspended_by_source ?? 'platform',
                          name: user.suspended_by_name ?? null,
                      },
                  }
                : null,
        // Same pairing rule as `suspension` above: present only in the status it describes.
        closedAt: user.status === 'closed' ? toIso(user.closed_at) : null,
        createdAt: toIso(user.created_at) ?? String(user.created_at),
        updatedAt: toIso(user.updated_at) ?? String(user.updated_at),
    };
}

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The fields a write can change, as the audit row's `before`.
 *
 * Deliberately the same four keys the gateway derives its `after` from, so the two halves
 * of a diff line up. A `before` shaped differently from its `after` is a diff nobody can
 * read.
 */
function toAuditState(user: UserReadModel): Record<string, unknown> {
    return {
        email: user.login_email ?? null,
        phone: user.login_phone ?? null,
        status: user.status,
        suspendedReason: user.suspended_reason ?? null,
    };
}

/**
 * Load the user or 404 — and return the row, because every write needs it twice: once to
 * refuse a request against a user that does not exist, and once as the audit `before`.
 *
 * Reading before delegating costs one indexed lookup and buys the two things the gateway
 * cannot get from jovi-mall's answer: the previous state, and a 404 that says "no such
 * user" rather than a `PLATFORM_OPERATION_REJECTED` wrapping one.
 */
async function loadOr404(userId: string): Promise<UserReadModel> {
    const user = await users.findById(userId);
    if (!user) throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'User not found');
    return user;
}

export class UserController {
    /**
     * GET /api/v1/users/:userId/closure-requests — jovi-mall ADR-A10.
     *
     * Every request to close one of this account's roles, newest first, with how the user
     * answered. Read directly; the user's confirm and decline happen in jovi-mall under their
     * own session, so this row is the only place an administrator sees the outcome.
     */
    static listClosureRequests = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.userId);
        const rows = await closureRequests.listForUser(req.params.userId);
        sendSuccess(res, rows.map((row) => toRoleClosureDto(row)));
    });

    /**
     * POST /api/v1/users/:userId/roles/:role/closure — ask the user to close one role.
     *
     * ⚠ This closes NOTHING. It sends the user a notice; the closure happens only if they
     * confirm, signed in as that role, within seven days (owner decision O-3).
     */
    static requestClosure = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RequestRoleClosureBody;
        const before = await loadOr404(req.params.userId);
        const request = await gateway.requestRoleClosure(
            req.params.userId,
            req.params.role,
            body.reason,
            toAuditState(before),
            actorContextOf(req),
        );
        sendSuccess(res, request, {
            status: 201,
            message: 'Closure requested — nothing changes unless the user confirms',
        });
    });

    /** DELETE /api/v1/users/:userId/roles/:role/closure — withdraw the pending request. */
    static cancelClosure = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadOr404(req.params.userId);
        const request = await gateway.cancelRoleClosure(
            req.params.userId,
            req.params.role,
            toAuditState(before),
            actorContextOf(req),
        );
        sendSuccess(res, request, { message: 'Closure request withdrawn' });
    });

    /**
     * GET /api/v1/users — search and filter across every role.
     *
     * `search` matches an email, a phone number, a user id, or the id of one of the
     * person's profiles (BR-028); `role`, `status` and the `from`/`to` creation range narrow
     * it. Sorting is limited to the indexed fields in `USER_SORT`, so no query string can ask
     * for a collection scan.
     *
     * The profile id is resolved to its account FIRST, then the page is served from `users`
     * on its own index. The resolver answers `[]` for any term that is not id-shaped, so a
     * name or a phone search pays nothing for it.
     *
     * ── `meta.idMatch` (BR-029) ───────────────────────────────────────────────
     * The row that comes back for a profile id is the ACCOUNT, so its `id` is not the id
     * that was typed. `meta.idMatch.kinds` says what the typed id was: `user`, `customer`,
     * `vendor`, `agency`, `agent`. It is present exactly when the term was read as an id,
     * `[]` when that id is nobody's, and absent for every other term.
     *
     * It describes the ID, not the page: both reads behind it ignore `role`, `status` and
     * the date range. That is what lets the dashboard tell "a filter is hiding this
     * account" from "this id is nobody's" when the page is empty. It discloses nothing the
     * caller could not get by sending the same search without the filter.
     */
    static search = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as SearchUsersQuery;

        const idTerm = query.search && isWholeId(query.search) ? query.search : null;
        const [owners, isUserId] = idTerm
            ? await Promise.all([findProfileOwners(idTerm), users.existsById(idTerm)])
            : [[] as ProfileOwner[], false];
        const profileUserIds = owners.map((owner) => owner.userId);

        const page = await users.search(
            {
                search: query.search,
                role: query.role,
                status: query.status,
                from: query.from,
                to: query.to,
                page: query.page,
                limit: query.limit,
                sort: query.sort,
            },
            profileUserIds,
        );

        // `sendSuccess`, not `sendPaginated`: `idMatch` is an object, and the paginated
        // helper's meta type admits scalars only. Same form as the earnings accounts' `totals`.
        sendSuccess(res, page.items.map(toUserDto), {
            meta: {
                ...toPageMeta(page.total, page.page, page.limit),
                ...(idTerm ? { idMatch: { kinds: idMatchKinds(isUserId, owners) } } : {}),
            },
        });
    });

    /**
     * GET /api/v1/users/:userId
     *
     * The account plus one entry per role it holds — including a role whose entity is
     * missing, which is a state that stops that person signing in and would otherwise be
     * invisible.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const user = await loadOr404(req.params.userId);
        const profiles = await findRoleProfiles(user._id, user.roles ?? []);

        const detail: UserDetailDto = { ...toUserDto(user), profiles };
        sendSuccess(res, detail);
    });

    /**
     * PATCH /api/v1/users/:userId — change the login identifiers.
     *
     * The only user fields an administrator may edit. jovi-mall validates the formats and
     * owns the uniqueness rule, so a malformed address comes back as its own 400 and a
     * collision as its own 409, each carrying `details.platformCode`.
     */
    static update = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as UpdateUserBody;
        const before = await loadOr404(req.params.userId);

        const updated = await gateway.updateContact(
            req.params.userId,
            { email: body.email, phone: body.phone },
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Login details updated' });
    });

    /**
     * POST /api/v1/users/:userId/suspend
     *
     * Takes effect on the suspended person's NEXT request, not at their next login:
     * jovi-mall re-reads the account on every authenticated request and refuses a
     * non-active one, and its refresh rotation refuses too, so a live session cannot
     * outlive this call.
     */
    static suspend = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SuspendUserBody;
        const before = await loadOr404(req.params.userId);

        const updated = await gateway.suspend(
            req.params.userId,
            body.reason,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, updated, { message: 'Account suspended — every device is signed out' });
    });

    /** POST /api/v1/users/:userId/restore — lift a suspension. */
    static restore = asyncHandler(async (req: Request, res: Response) => {
        const before = await loadOr404(req.params.userId);

        const updated = await gateway.restore(req.params.userId, toAuditState(before), actorContextOf(req));

        sendSuccess(res, updated, { message: 'Account restored' });
    });

    /**
     * POST /api/v1/users/:userId/password-reset-link — body `{ channel, reason }`.
     *
     * Sends the party a link to set a new password themselves. Every role: a password
     * belongs to the `users` row, and vendors and agencies are exactly the people who have
     * one to forget.
     *
     * ⚠ **This does not reset anything.** The administrator never learns or chooses the
     * credential — which is the whole difference from `POST /administrators/:adminId/password-reset`
     * one mount over, where the password is generated and shown once because an
     * administrator has no other channel to be reached on. A platform party has three.
     *
     * The response carries a masked destination and nothing else usable.
     */
    static sendPasswordResetLink = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SendCredentialBody;
        const before = await loadOr404(req.params.userId);

        const result = await gateway.sendPasswordResetLink(
            req.params.userId,
            body.channel,
            body.reason,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: `Password-reset link sent by ${body.channel}` });
    });

    /**
     * POST /api/v1/users/:userId/login-link — body `{ channel, reason }`.
     *
     * Sends a customer a passwordless sign-in link. **Customers only**, refused with
     * `USER_LOGIN_LINK_ROLE_UNSUPPORTED` otherwise, and that refusal is structural rather
     * than configurable: jovi-mall scopes every session this mints to `customer` as a
     * literal, because a vendor, agency or agent reaches money and other people's data.
     *
     * Its own permission, because whoever opens the message IS signed in as that customer.
     * A reset link grants nothing until a password is chosen; this is not that.
     */
    static sendLoginLink = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as SendCredentialBody;
        const before = await loadOr404(req.params.userId);

        const result = await gateway.sendLoginLink(
            req.params.userId,
            body.channel,
            body.reason,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: `Sign-in link sent by ${body.channel}` });
    });

    /**
     * POST /api/v1/users/:userId/bot-memory/reset — body `{ reason? }`.
     *
     * Makes the customer bot (WhatsApp and Telegram) start this person's next conversation
     * fresh. It is the remedy when the bot is confused by something it remembers. It deletes
     * no order, message record or account data, and the answer carries only
     * `{ userId, memoryEpoch, resetAt }`.
     *
     * Held by every tier, Support included (see `users.bot_memory.reset` in the catalog). The
     * 404 is checked here first, the same as the other writes, so an unknown id reads as "no
     * such user" and never as a platform refusal.
     */
    static resetBotMemory = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as ResetBotMemoryBody;
        const before = await loadOr404(req.params.userId);

        const result = await gateway.resetBotMemory(
            req.params.userId,
            body.reason ?? null,
            toAuditState(before),
            actorContextOf(req),
        );

        sendSuccess(res, result, { message: 'Bot memory reset — the next conversation starts fresh' });
    });

    /**
     * GET /api/v1/users/:userId/cod-restriction — whether an administrator switched cash on
     * delivery off for this account's CUSTOMER profile (2026-10-10), with the reason and who
     * did it. `restriction: null` means not restricted.
     *
     * Delegated. An account with no customer profile answers 404 with
     * `details.platformCode: "AUTH_PROFILE_NOT_FOUND"` — the switch exists for customers
     * only. The detail's customer profile carries the same record as `codRestriction`, read
     * directly, so a badge needs no second call.
     */
    static codRestriction = asyncHandler(async (req: Request, res: Response) => {
        await loadOr404(req.params.userId);
        const report = await gateway.codRestriction(req.params.userId, actorContextOf(req));
        sendSuccess(res, report);
    });

    /**
     * PUT /api/v1/users/:userId/cod-restriction — body `{ reason }`.
     *
     * Switches cash on delivery OFF for the customer: they can no longer PLACE a COD order.
     * Checkout refuses it and the cart quote stops offering it, on the website and in the
     * bot alike. Orders already placed and every other payment method are untouched.
     *
     * The audit `before` is the restriction as jovi-mall reports it (`current`), so the row
     * reads `codRestricted: false → true`. That read is also where an account with no customer
     * profile is refused (`AUTH_PROFILE_NOT_FOUND`) — before any audit row is opened, since
     * nothing was attempted. Already restricted is `409 COD_RESTRICTION_UNCHANGED`.
     */
    static restrictCod = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as RestrictUserCodBody;
        const user = await loadOr404(req.params.userId);
        const context = actorContextOf(req);
        const current = await gateway.codRestriction(req.params.userId, context);

        const updated = await gateway.restrictCod(
            req.params.userId,
            body.reason,
            toAuditState(user),
            current,
            context,
        );
        sendSuccess(res, updated, { message: 'Cash on delivery restricted for this customer' });
    });

    /**
     * POST /api/v1/users/:userId/cod-restriction/lift — body `{ reason }`.
     *
     * Switches cash on delivery back on for the customer. Not restricted is the same
     * `409 COD_RESTRICTION_UNCHANGED`.
     */
    static liftCodRestriction = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as LiftUserCodRestrictionBody;
        const user = await loadOr404(req.params.userId);
        const context = actorContextOf(req);
        const current = await gateway.codRestriction(req.params.userId, context);

        const updated = await gateway.liftCodRestriction(
            req.params.userId,
            body.reason,
            toAuditState(user),
            current,
            context,
        );
        sendSuccess(res, updated, { message: 'Cash on delivery restriction lifted for this customer' });
    });

    /**
     * GET /api/v1/users/:userId/activity — what administrators have done to this account.
     *
     * ── What this feed is, and what it is not ─────────────────────────────────
     * It is the audit trail filtered to this user as its target: every suspension,
     * reinstatement and identifier change, who made it, from where, and whether it
     * succeeded. That is the activity a user-management screen is accountable for.
     *
     * It is NOT the person's own platform activity — their orders, shipments and tickets.
     * Those live in other domains behind other permissions (`orders.read`,
     * `shipments.read`), and assembling them here would let `users.read` alone reach data
     * those permissions exist to gate.
     *
     * The audit repository applies its own per-tier read scope on top of this filter.
     * `user` rows are `platform_actor`, which every tier may read — so a Support
     * administrator sees this feed, deliberately: they already hold `users.read`, and
     * seeing what was done to an account they can look up is the point of the role.
     */
    static activity = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const query = req.query as unknown as ListUserActivityQuery;

        // 404 first: an activity feed for a user that does not exist should say so, not
        // answer an empty page that looks like "nothing ever happened".
        await loadOr404(req.params.userId);

        const page = await audit.search(
            {
                page: query.page,
                limit: query.limit,
                sort: query.sort,
                action: query.action,
                status: query.status,
                from: query.from,
                to: query.to,
                // The subject is fixed by the path — a caller cannot widen it.
                targetType: 'user',
                targetId: req.params.userId,
            } as ListAuditQuery,
            identity,
        );

        sendPaginated(res, page.items.map(toAuditEntryDto), page.meta);
    });
}

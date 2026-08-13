import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminTier } from '../../admin-identity/domain/admin-identity.types';

/**
 * The rules for one administrator acting on another.
 *
 * ── Why this exists at all ────────────────────────────────────────────────────
 * Holding `administrators.suspend` answers "may this person suspend administrators".
 * It does not answer "may this person suspend THAT administrator", and the difference is
 * the entire privilege-escalation surface: without these rules, any account holding the
 * administrator permissions can promote itself to Developer, or suspend everyone above
 * it, and the permission check happily allows it.
 *
 * This is the "never rely solely on tier checks when a resource-specific permission is
 * required" requirement, inverted and made concrete: never rely solely on the PERMISSION
 * when the resource is another administrator.
 *
 * ── Why it is one pure function ───────────────────────────────────────────────
 * Escalation rules that live inside controllers get checked on the paths someone
 * remembered. One function, no I/O, called by every path — and exhaustively testable
 * without a database, which is why `test-authz.ts` can assert the whole matrix.
 *
 * ── Remember the inversion ────────────────────────────────────────────────────
 * LOWER tier number = MORE privilege. 1 Developer, 2 Admin, 3 Support. So
 * `target.tier > actor.tier` means "the target is less privileged than the actor", which
 * is the only direction in which action is allowed.
 */

export type AdminAction =
    | 'create'
    | 'update'
    | 'suspend'
    | 'reinstate'
    | 'set_tier'
    /**
     * Listing another administrator's live sessions.
     *
     * A read, and still governed by rule 2 — which the other reads on this surface are
     * not. The difference is what it discloses: IP addresses and user agents, i.e. where
     * a colleague is working from and on what. `administrators.sessions.read` is swept
     * into tier 2 by `allInFamily`, so without this an Admin could enumerate a
     * DEVELOPER's devices while rule 2 forbade them from acting on that Developer at all
     * — and the revoke route immediately beside it did run the check. The asymmetry was
     * an oversight, not a policy.
     */
    | 'read_sessions'
    | 'revoke_sessions'
    | 'reset_password'
    /**
     * Clearing another administrator's two-factor enrolment.
     *
     * Governed by rule 2 like every other write here, and worth naming separately from
     * `reset_password` because it removes a DIFFERENT control — the one that survives a
     * stolen password. Sharing a label with the password reset would make the two
     * indistinguishable in a denial row, which is the row that matters if somebody is
     * probing for a way into a peer's account.
     */
    | 'reset_mfa';

/**
 * Actions against an administrator who already exists.
 *
 * `create` is excluded because it has no target: the rules about acting on someone else
 * cannot apply to someone who does not exist yet. It gets its own entry point below,
 * rather than a synthetic target whose tier is the level being assigned — which would
 * read as if rule 2 were doing the work when rule 4 is.
 */
export type ExistingAdminAction = Exclude<AdminAction, 'create'>;

export interface ActorRef {
    adminId: string;
    tier: AdminTier;
}

export interface TargetRef {
    adminId: string;
    tier: AdminTier;
}

export interface EscalationVerdict {
    /**
     * True when the action is permitted but must be committed by a SECOND administrator.
     * The caller queues an approval instead of executing — see the dual-control module.
     */
    dualControlRequired: boolean;
    /** Why, in one line, for the approval queue and the denial record. */
    reason?: string;
}

/**
 * Actions that are refused on your own account, whatever you hold.
 *
 * `update` is absent on purpose: editing your own display name is not an escalation, and
 * forbidding it would mean an administrator cannot maintain their own profile.
 *
 * `reinstate` is also absent — a suspended administrator cannot authenticate at all
 * (`authenticate.middleware.ts:100-106` destroys their sessions and refuses the request),
 * so self-reinstatement is unreachable rather than forbidden.
 *
 * `read_sessions` is absent for the same reason as `update`: reading your own sessions is
 * what `GET /auth/sessions` is for, and forbidding it here would refuse an administrator
 * sight of their own devices.
 */
const SELF_FORBIDDEN: ReadonlySet<AdminAction> = new Set<AdminAction>([
    'suspend',
    'set_tier',
    'revoke_sessions',
    'reset_password',
]);

/**
 * Rule 4, shared by `create` and `set_tier`: never assign a level at or above your own.
 *
 * Caps what an actor can MINT, which rule 2 alone does not: without it an Admin could
 * create a Support account and immediately promote it to Admin, acquiring a peer it is
 * then forbidden to touch.
 *
 * The single exception is a Developer assigning tier 1 — creating a peer Developer —
 * permitted precisely because the catalog's `PROMOTE_TO_DEVELOPER` spec dual-controls it.
 */
function assertMayAssignTier(actor: ActorRef, newTier: AdminTier, action: AdminAction): EscalationVerdict {
    const mintingPeerDeveloper = actor.tier === 1 && newTier === 1;

    if (newTier <= actor.tier && !mintingPeerDeveloper) {
        throw createAppError(ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN, 403, undefined, {
            action,
            assigned: newTier,
        });
    }

    return mintingPeerDeveloper
        ? { dualControlRequired: true, reason: 'Granting Developer level requires a second Developer’s approval' }
        : { dualControlRequired: false };
}

/**
 * Whether `actor` may create an administrator at `newTier`.
 *
 * Only rule 4 applies — there is no target yet to protect.
 */
export function assertMayCreate(actor: ActorRef, newTier: AdminTier): EscalationVerdict {
    return assertMayAssignTier(actor, newTier, 'create');
}

/**
 * Decide whether `actor` may perform `action` on an existing `target`.
 *
 * Throws an `AppError` (403) on refusal. Returns whether the action additionally needs a
 * second administrator's approval before it may be committed.
 *
 * @param opts.newTier the level being assigned. Required for `set_tier`.
 */
export function assertMayActOn(
    actor: ActorRef,
    target: TargetRef,
    action: ExistingAdminAction,
    opts: { newTier?: AdminTier } = {},
): EscalationVerdict {
    // ── Rule 1: never act on yourself ────────────────────────────────────────
    // The rule that stops the obvious self-service escalation, and also stops the
    // obvious self-inflicted lockout: a Developer cannot demote or suspend themselves
    // into a platform with no Developer.
    if (actor.adminId === target.adminId) {
        if (SELF_FORBIDDEN.has(action)) {
            throw createAppError(ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN, 403, undefined, { action });
        }
        // Everything else on yourself — in practice `update` — is allowed and stops here.
        // It must NOT fall through to rule 2: your own level is by definition equal to
        // your own level, so the peer-protection rule would refuse an administrator the
        // right to edit their own display name.
        return { dualControlRequired: false };
    }

    // ── Rule 2: never act on an equal or more privileged administrator ───────
    // An Admin (2) manages Support (3) and nobody else. Equality is refused as firmly as
    // superiority: two Admins who can suspend each other is a denial-of-service between
    // peers, and two Developers who can demote each other is a coin flip for control of
    // the platform.
    //
    // ── Rule 3, the exception that makes Developers recoverable ──────────────
    // A Developer acting on ANOTHER Developer is allowed, but only with a second
    // Developer's approval. Without this, a compromised or departed Developer account
    // could never be contained through the API at all — rule 2 would protect it from
    // every other Developer, and rule 1 from itself.
    //
    // A single-Developer installation therefore cannot suspend that Developer through the
    // API. That is correct rather than an oversight: with one Developer there is no
    // second pair of eyes to be had, and the documented break-glass path is the database.
    const peerDeveloperAction = actor.tier === 1 && target.tier === 1;

    if (target.tier <= actor.tier && !peerDeveloperAction) {
        throw createAppError(ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED, 403, undefined, { action });
    }

    let dualControlRequired = false;
    let reason: string | undefined;

    if (peerDeveloperAction) {
        dualControlRequired = true;
        reason = 'One Developer acting on another requires a second Developer’s approval';
    }

    // ── Rule 4: never assign a level at or above your own ────────────────────
    if (action === 'set_tier') {
        const newTier = opts.newTier;
        if (newTier === undefined) {
            // A programming error, not a caller error: the route forgot to pass the level
            // it is assigning. Fail closed and loudly rather than authorizing a blank.
            throw createAppError(
                ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN,
                500,
                'assertMayActOn("set_tier") requires opts.newTier',
            );
        }

        const assignment = assertMayAssignTier(actor, newTier, 'set_tier');
        if (assignment.dualControlRequired) {
            dualControlRequired = true;
            reason = assignment.reason;
        }
    }

    return { dualControlRequired, reason };
}

/**
 * The non-throwing form, for rendering a UI.
 *
 * The dashboard uses this to decide whether to draw a "Suspend" button beside a row.
 * It is a convenience over the same rules — never a substitute for calling
 * `assertMayActOn` on the write path.
 */
export function mayActOn(
    actor: ActorRef,
    target: TargetRef,
    action: ExistingAdminAction,
    opts: { newTier?: AdminTier } = {},
): boolean {
    try {
        assertMayActOn(actor, target, action, opts);
        return true;
    } catch {
        return false;
    }
}

import { ClientSession, Types } from 'mongoose';
import { matchAnyField } from '../../../core/data/mongo-list';
import { AdminAccountModel, IAdminAccount } from '../models/admin-account.model';
import { AdminStatus, AdminTier } from '../domain/admin-identity.types';

/**
 * Data access for `admin_accounts`.
 *
 * Every method returns the raw document including `password_hash` — this layer is
 * trusted, and the service above it decides what reaches a DTO. The model's `toJSON`
 * transform strips credentials as a backstop for anything that slips into a response
 * by accident.
 */

export interface CreateAdminInput {
    email: string;
    displayName: string;
    passwordHash: string;
    tier: AdminTier;
    jobTitle?: string | null;
    department?: string | null;
    /** The administrator who created this one. Null for the bootstrap CLI. */
    createdBy?: string | null;
}

/** Fields an administrator may change on a profile — their own or someone else's. */
export interface UpdateAdminProfileInput {
    displayName?: string;
    jobTitle?: string | null;
    department?: string | null;
    timezone?: string;
    preferredLanguage?: string;
}

export interface ListAdminsFilter {
    tier?: AdminTier;
    status?: AdminStatus;
    /** Case-insensitive substring of email or display name. */
    search?: string;
    page: number;
    limit: number;
}

export class AdminAccountRepository {
    /**
     * `session` is REQUIRED, not optional — and that is the enforcement, not a note.
     *
     * Creating an administrator is one of the five escalation-critical writes, and each of
     * them commits inside the same transaction as its audit row. Typing the parameter as
     * required means an unaudited administrator mutation does not compile: there is no
     * call path to this method that does not come through `auditedTransaction`, which is
     * the only place in `src/` that opens a session.
     */
    async create(input: CreateAdminInput, session: ClientSession): Promise<IAdminAccount> {
        // Array form, always. `create(doc, options)` is read as a SECOND DOCUMENT by some
        // Mongoose versions, which would write outside the session and silently defeat the
        // atomicity this parameter exists to provide.
        const [created] = await AdminAccountModel().create([{
            email: input.email,
            display_name: input.displayName,
            password_hash: input.passwordHash,
            password_updated_at: new Date(),
            tier: input.tier,
            status: 'active',
            job_title: input.jobTitle ?? null,
            department: input.department ?? null,
            created_by: input.createdBy ? new Types.ObjectId(input.createdBy) : null,
        }], { session });

        return created;
    }

    /** Case-insensitive by normalisation — the schema lowercases on write, so lowercase on read. */
    async findByEmail(email: string, session?: ClientSession): Promise<IAdminAccount | null> {
        return AdminAccountModel().findOne({ email: email.trim().toLowerCase() }).session(session ?? null);
    }

    /**
     * `session` is optional, but load-bearing wherever it is passed: the read that computes
     * an audit row's `before` state must run INSIDE the transaction that is about to change
     * it. Read outside, and the row records a state that may already have been overwritten
     * by the time the change commits — a `before` that was never immediately before.
     */
    async findById(adminId: string, session?: ClientSession): Promise<IAdminAccount | null> {
        if (!Types.ObjectId.isValid(adminId)) return null;
        return AdminAccountModel().findById(adminId).session(session ?? null);
    }

    /**
     * Display names for a page of administrator ids, batched (BR-015).
     *
     * ⚠ **The one owner type on the media library that resolves in THIS database.** A file
     * uploaded by an administrator carries `ownerType: 'admin'` and an `ownerId` that is a
     * `wi_admin.admin_accounts._id` — written into a jovi-mall column declared
     * `ref: MODELS.USER`, where it dereferences to nothing (ADR-004 D-1). jovi-mall cannot
     * name that owner and never will; this method is the only thing that can.
     *
     * ── The projection is two fields, and it is not decoration ────────────────
     * `admin_accounts` is the credential collection — `password_hash`, `mfa_secret`,
     * `failed_attempts`, `locked_until`. Every other read of it on this service goes through
     * a mapper that strips those; this one is a name lookup feeding a file listing, so it
     * names the two columns it wants rather than loading documents and picking.
     *
     * `.lean()` because nothing here needs a document — and a Mongoose document carries the
     * whole row into memory regardless of what the caller then reads off it.
     */
    async findDisplayNamesByIds(adminIds: string[]): Promise<Map<string, string | null>> {
        const ids = adminIds.filter((id) => Types.ObjectId.isValid(id));
        if (ids.length === 0) return new Map();

        const rows = await AdminAccountModel()
            .find({ _id: { $in: ids } }, { _id: 1, display_name: 1 })
            .lean();

        return new Map(rows.map((row) => [String(row._id), row.display_name ?? null]));
    }

    /** Backs the bootstrap CLI's refusal to create a second first-administrator. */
    async countByTier(tier: AdminTier): Promise<number> {
        return AdminAccountModel().countDocuments({ tier });
    }

    async countAll(): Promise<number> {
        return AdminAccountModel().countDocuments({});
    }

    async recordSuccessfulLogin(adminId: string, ip: string | null): Promise<void> {
        await AdminAccountModel().updateOne(
            { _id: adminId },
            { $set: { last_login_at: new Date(), last_login_ip: ip, failed_attempts: 0, locked_until: null } },
        );
    }

    /**
     * Mirror of the Redis counter, for an operator inspecting the account. Redis remains
     * authoritative for the lock decision — this is visibility, not enforcement.
     */
    async recordFailedAttempt(adminId: string, failedAttempts: number, lockedUntil: Date | null): Promise<void> {
        await AdminAccountModel().updateOne(
            { _id: adminId },
            { $set: { failed_attempts: failedAttempts, locked_until: lockedUntil } },
        );
    }

    async setStatus(adminId: string, status: AdminStatus): Promise<IAdminAccount | null> {
        return AdminAccountModel().findByIdAndUpdate(adminId, { $set: { status } }, { new: true });
    }

    // ── Administrator management (Phase 3) ───────────────────────────────────

    async list(filter: ListAdminsFilter): Promise<{ items: IAdminAccount[]; total: number }> {
        const query: Record<string, unknown> = {};
        if (filter.tier !== undefined) query.tier = filter.tier;
        if (filter.status !== undefined) query.status = filter.status;
        // `matchAnyField` escapes the term — one implementation, so a repository added
        // later cannot ship a search box that feeds a caller's pattern to the query
        // planner. See `core/data/mongo-list.ts`.
        if (filter.search) Object.assign(query, matchAnyField(['email', 'display_name'], filter.search));

        const [items, total] = await Promise.all([
            AdminAccountModel()
                .find(query)
                .sort({ tier: 1, created_at: -1 })
                .skip((filter.page - 1) * filter.limit)
                .limit(filter.limit),
            AdminAccountModel().countDocuments(query),
        ]);

        return { items, total };
    }

    async updateProfile(
        adminId: string,
        input: UpdateAdminProfileInput,
        session: ClientSession,
    ): Promise<IAdminAccount | null> {
        const update: Record<string, unknown> = {};
        if (input.displayName !== undefined) update.display_name = input.displayName;
        if (input.jobTitle !== undefined) update.job_title = input.jobTitle;
        if (input.department !== undefined) update.department = input.department;
        if (input.timezone !== undefined) update.timezone = input.timezone;
        if (input.preferredLanguage !== undefined) update.preferred_language = input.preferredLanguage;

        if (Object.keys(update).length === 0) {
            return this.findById(adminId, session);
        }

        return AdminAccountModel().findByIdAndUpdate(adminId, { $set: update }, { new: true, session });
    }

    /**
     * Change an administrator's level, guarded by their CURRENT level.
     *
     * `expectedTier` is a compare-and-set. Two administrators editing the same account
     * concurrently would otherwise both read tier 3, both write, and the loser's decision
     * would silently win — with `tier_changed_by` naming whoever wrote last. A miss
     * returns `null` and the service reports a conflict.
     */
    async setTier(
        adminId: string,
        tier: AdminTier,
        expectedTier: AdminTier,
        changedBy: string,
        session: ClientSession,
    ): Promise<IAdminAccount | null> {
        if (!Types.ObjectId.isValid(adminId)) return null;
        return AdminAccountModel().findOneAndUpdate(
            { _id: adminId, tier: expectedTier },
            {
                $set: {
                    tier,
                    tier_changed_at: new Date(),
                    tier_changed_by: new Types.ObjectId(changedBy),
                },
            },
            { new: true, session },
        );
    }

    /** Suspend with provenance, or reinstate and clear it. */
    async setSuspension(
        adminId: string,
        suspension: { by: string; reason: string } | null,
        session: ClientSession,
    ): Promise<IAdminAccount | null> {
        if (!Types.ObjectId.isValid(adminId)) return null;

        const update = suspension
            ? {
                status: 'suspended' as AdminStatus,
                suspended_at: new Date(),
                suspended_by: new Types.ObjectId(suspension.by),
                suspended_reason: suspension.reason,
            }
            : {
                status: 'active' as AdminStatus,
                suspended_at: null,
                suspended_by: null,
                suspended_reason: null,
            };

        return AdminAccountModel().findByIdAndUpdate(adminId, { $set: update }, { new: true, session });
    }

    /**
     * Replace the password hash.
     *
     * `failed_attempts` and `locked_until` are cleared alongside it: a reset exists to
     * restore access, and leaving a lockout in place would defeat it.
     */
    async setPasswordHash(
        adminId: string,
        passwordHash: string,
        session: ClientSession,
    ): Promise<IAdminAccount | null> {
        if (!Types.ObjectId.isValid(adminId)) return null;
        return AdminAccountModel().findByIdAndUpdate(
            adminId,
            {
                $set: {
                    password_hash: passwordHash,
                    password_updated_at: new Date(),
                    failed_attempts: 0,
                    locked_until: null,
                },
            },
            { new: true, session },
        );
    }

    /** Stores the secret INACTIVE — `mfa_enrolled` stays false until a code is verified. */
    async stageMfaSecret(adminId: string, encryptedSecret: string, session?: ClientSession): Promise<void> {
        await AdminAccountModel().updateOne(
            { _id: adminId },
            { $set: { mfa_secret: encryptedSecret, mfa_enrolled: false, mfa_activated_at: null } },
            { session },
        );
    }

    async activateMfa(adminId: string, session?: ClientSession): Promise<void> {
        await AdminAccountModel().updateOne(
            { _id: adminId },
            { $set: { mfa_enrolled: true, mfa_activated_at: new Date() } },
            { session },
        );
    }

    /**
     * Clear another administrator's two-factor enrolment, so they can enrol afresh.
     *
     * `session` is REQUIRED — the sixth escalation-critical write. Removing the strongest
     * control on a privileged account belongs in the same column as creating one or
     * changing its level, and typing the parameter required means it cannot happen outside
     * `auditedTransaction`.
     *
     * The SECRET is cleared, not just the flag. Leaving `mfa_secret` behind would let the
     * old authenticator work again the moment somebody re-enrolled, which is the opposite
     * of what a reset is for — the point is that the lost device stops being a credential.
     *
     * Returns the updated document so the caller can diff, and null when no such account —
     * the same shape `setPasswordHash` uses, so a 404 is a missing row rather than a throw
     * from inside the transaction.
     */
    async clearMfa(adminId: string, session: ClientSession): Promise<IAdminAccount | null> {
        if (!Types.ObjectId.isValid(adminId)) return null;
        return AdminAccountModel().findByIdAndUpdate(
            adminId,
            { $set: { mfa_secret: null, mfa_enrolled: false, mfa_activated_at: null } },
            { new: true, session },
        );
    }
}

import { AdminAccountModel } from '../models/admin-account.model';
import { AdminIdentity } from './admin-identity.types';
import { platformRequest, isPlatformConfigured } from '../../../infra/platform/platform.client';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';

/**
 * An administrator's own phone number, and proving it.
 *
 * ── The split with jovi-mall, and why it falls this way ──────────────────────
 *
 * jovi-mall **sends and judges the code**: it owns the WhatsApp Cloud API credentials, the
 * 24-hour service-window bookkeeping and the approved templates. A second copy here would mean
 * two services holding the same Meta credentials and two window caches disagreeing about
 * whether a free-form message is allowed.
 *
 * This service **owns the record**: administrators live in this database and jovi-mall has no
 * row to stamp. Its confirm answers "this number was proved" and stops; the write below is
 * ours. That is ADR-004 D-2's rule applied to a new case — and it keeps the identity
 * separation the whole admin architecture rests on, because jovi-mall never learns what an
 * administrator *is*.
 *
 * ── ⚠ This is a CONTACT detail, not a login factor ───────────────────────────
 *
 * Administrators already have TOTP MFA. A WhatsApp OTP is *weaker* than an authenticator app,
 * so wiring this into the login would degrade it. Nothing in the auth path reads `phone` or
 * `phone_verified`, and making it do so is a security decision rather than a refactor.
 */
export class AdminPhoneService {
    /**
     * Set or replace the number.
     *
     * ⚠ **Setting a number always clears `phone_verified`.** The obvious alternative — keep the
     * flag and re-verify later — means a row that claims a number is proved while holding a
     * different number, which is worse than unverified: unverified is honest.
     */
    async setPhone(actor: AdminIdentity, phone: string): Promise<{ phone: string; verified: boolean }> {
        const normalized = phone.trim();

        await AdminAccountModel().updateOne(
            { _id: actor.adminId },
            { $set: { phone: normalized, phone_verified: false, phone_verified_at: null } },
        );

        return { phone: normalized, verified: false };
    }

    /** Ask jovi-mall to send a code to the number on this administrator's account. */
    async requestCode(actor: AdminIdentity, requestId: string): Promise<{ phoneMasked: string; expiresAt: string; delivery: string }> {
        const account = await this.requireAccount(actor);

        if (!account.phone) {
            throw createAppError(
                ERROR_CODES.ADMIN_PHONE_NOT_SET,
                422,
                'Set a phone number on your profile before verifying it',
            );
        }

        this.assertPlatform();

        const { data } = await platformRequest<{ phoneMasked: string; expiresAt: string; delivery: string }>({
            method: 'post',
            path: '/phone-verification/request',
            actor,
            requestId,
            body: { phone: account.phone, language: account.preferred_language },
        });

        return data;
    }

    /**
     * Spend the code, then stamp the record.
     *
     * ⚠ **The proved number is compared against the one on the account before stamping.** The
     * two can disagree: an administrator can change their number in the ten minutes between
     * requesting a code and typing it, and jovi-mall — which holds no admin record — cannot
     * know that happened. Without this check the code minted for the OLD number would mark the
     * NEW one verified, which is precisely the "proof bound to the wrong subject" failure the
     * whole namespacing exercise exists to prevent, one layer up.
     */
    async confirmCode(actor: AdminIdentity, code: string, requestId: string): Promise<{ phone: string; verified: boolean }> {
        const account = await this.requireAccount(actor);
        this.assertPlatform();

        const { data } = await platformRequest<{ phone: string; verified: boolean }>({
            method: 'post',
            path: '/phone-verification/confirm',
            actor,
            requestId,
            body: { code },
        });

        if (!account.phone || data.phone !== account.phone) {
            throw createAppError(
                ERROR_CODES.ADMIN_PHONE_VERIFICATION_MISMATCH,
                409,
                'That code was sent for a different number. Request a new one.',
            );
        }

        await AdminAccountModel().updateOne(
            { _id: actor.adminId },
            { $set: { phone_verified: true, phone_verified_at: new Date() } },
        );

        return { phone: account.phone, verified: true };
    }

    private async requireAccount(actor: AdminIdentity) {
        const account = await AdminAccountModel().findById(actor.adminId).lean();
        if (!account) {
            throw createAppError(ERROR_CODES.NOT_FOUND, 404, 'Administrator account not found');
        }
        return account;
    }

    /**
     * ⚠ Refused explicitly rather than left to `platformRequest`'s own 503, so the message names
     * the cause. With `JOVI_MALL_BASE_URL` unset this service is deliberately inert against the
     * platform — the same convention jovi-mall uses for an unset `GEO_TRACKER_BASE_URL` — and an
     * operator reading "phone verification is unavailable" should not have to guess why.
     */
    private assertPlatform(): void {
        if (!isPlatformConfigured()) {
            throw createAppError(
                ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
                503,
                'Phone verification needs the platform service, which is not configured on this deployment',
            );
        }
    }
}

export const adminPhoneService = new AdminPhoneService();

import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../domain/admin-identity.types';
import { adminPhoneService } from '../domain/admin-phone.service';

/**
 * An administrator's own phone number — set it, prove it.
 *
 * Self-service throughout: every handler acts on the caller's own account, taken from the
 * verified session and never from a body. There is no permission for these, for the reason
 * `auth.routes.ts` gives about the rest of `/me`: a permission that must be granted to all
 * three tiers to be correct is noise rather than policy.
 *
 * ⚠ **The number is a CONTACT detail, not a login factor** — see `admin-phone.service.ts`.
 * Administrators already have TOTP; nothing in the auth path reads these fields.
 */
export class AdminPhoneController {
    /** PATCH /api/v1/auth/me/phone — set or replace it. Always clears the verified flag. */
    static setPhone = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const { phone } = req.body as { phone: string };

        const result = await adminPhoneService.setPhone(identity, phone);

        sendSuccess(res, result, {
            message: 'Phone number saved. Verify it to confirm you can be reached there.',
        });
    });

    /** POST /api/v1/auth/me/phone/verify/request — jovi-mall sends the code over WhatsApp. */
    static requestCode = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const result = await adminPhoneService.requestCode(identity, req.requestId ?? 'unknown');

        sendSuccess(res, result, {
            message: `A verification code was sent to ${result.phoneMasked} on WhatsApp.`,
        });
    });

    /** POST /api/v1/auth/me/phone/verify/confirm — spend it, and stamp the record here. */
    static confirmCode = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const { code } = req.body as { code: string };

        const result = await adminPhoneService.confirmCode(identity, code, req.requestId ?? 'unknown');

        sendSuccess(res, result, { message: 'Your phone number is verified.' });
    });
}

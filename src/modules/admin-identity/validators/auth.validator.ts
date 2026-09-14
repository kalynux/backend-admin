import { z } from 'zod';

/**
 * Request schemas for `/api/v1/auth`.
 *
 * Note what is deliberately NOT validated strictly: the login password has no format
 * rule beyond being a non-empty string. Applying the write-time policy here would tell
 * an attacker which candidates are even worth trying, and would lock out an admin whose
 * password predates a policy change. Strength is enforced where a password is SET
 * (`password.service.ts`), never where one is checked.
 */

export const LoginSchema = z.object({
    email: z.string().trim().toLowerCase().email('A valid email address is required'),
    password: z.string().min(1, 'Password is required'),
});

export const MfaVerifySchema = z.object({
    challengeId: z.string().uuid('Invalid challenge'),
    // TOTP is exactly six digits; anything else is a client bug, not a wrong code.
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export const MfaActivateSchema = z.object({
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export const SessionIdParamSchema = z.object({
    sessionId: z.string().uuid('Invalid session id'),
});

/**
 * Changing your own password.
 *
 * `newPassword` is bounded here but its STRENGTH is not checked — `checkPasswordPolicy`
 * owns that, and it returns the specific problems as a 422 so the form can say which rule
 * failed. Duplicating the policy in Zod would make it two rules that must agree.
 *
 * `currentPassword` follows the same rule as login: non-empty, nothing more. It is being
 * checked, not set.
 */
export const ChangePasswordSchema = z
    .object({
        currentPassword: z.string().min(1, 'Your current password is required'),
        newPassword: z.string().min(1, 'A new password is required').max(200),
    })
    .refine((body) => body.currentPassword !== body.newPassword, {
        path: ['newPassword'],
        message: 'The new password must be different from the current one',
    });

export type LoginInput = z.infer<typeof LoginSchema>;
export type MfaVerifyInput = z.infer<typeof MfaVerifySchema>;
export type MfaActivateInput = z.infer<typeof MfaActivateSchema>;
export type ChangePasswordBody = z.infer<typeof ChangePasswordSchema>;

/**
 * An administrator's own contact phone.
 *
 * ⚠ `.strict()` like every schema here, and deliberately permissive on FORMAT: wi-admin does
 * not own the phone vocabulary — jovi-mall normalises to E.164 and is the service that will
 * refuse an unusable number when it tries to send. Duplicating the rule here would make this
 * the second place it lives, and the two would drift the first time E.164 handling changed.
 */
export const SetAdminPhoneSchema = z.object({
    phone: z.string().min(6).max(20),
}).strict();

export type SetAdminPhoneBody = z.infer<typeof SetAdminPhoneSchema>;

export const ConfirmAdminPhoneSchema = z.object({
    /**
     * ⚠ Only the code. The NUMBER is fixed when the code is minted and re-checked against the
     * account before the record is stamped — accepting one here would let a caller prove
     * control of one number and have another marked verified.
     */
    code: z.string().min(4).max(12),
}).strict();

export type ConfirmAdminPhoneBody = z.infer<typeof ConfirmAdminPhoneSchema>;

import bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';

/**
 * Password hashing and verification.
 *
 * Two properties this file exists to guarantee, both corrections of jovi-mall:
 *
 * 1. **A comparison ALWAYS runs**, even when no account matched. jovi-mall throws
 *    before reaching `bcrypt.compare` when the identifier is unknown, so a missing
 *    account answers in ~1ms and a wrong password in ~100ms. That difference turns
 *    the login form into an account-existence oracle. `verifyAgainstDummy()` burns
 *    the same work on the miss path.
 *
 * 2. **The verdict is used.** jovi-mall computes `isValid` and the line that would
 *    reject on a mismatch is commented out, so any password authenticates any
 *    account. `verify()` here returns a boolean its one caller must branch on, and
 *    there is no path that ignores it.
 */

/**
 * Cost 12 rather than jovi-mall's 10. Roughly 4× the work per attempt — negligible on
 * a login endpoint, meaningful against an offline crack of a stolen hash. Admin
 * credentials justify the trade.
 */
const BCRYPT_COST = 12;

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200; // bcrypt truncates past 72 bytes; reject long input rather than silently ignoring it

/**
 * Precomputed hash of a value no one can supply, used to spend comparison time on the
 * account-not-found path. Computed once at module load.
 */
const DUMMY_HASH = bcrypt.hashSync('::wi-admin-nonexistent-account-placeholder::', BCRYPT_COST);

/** Obvious choices that pass a length check but fall to the first page of any wordlist. */
const FORBIDDEN_PASSWORDS = new Set([
    'password', 'password123', 'administrator', 'admin1234567', 'qwertyuiop12',
    'changeme1234', '123456789012', 'letmein12345', 'welcome12345',
]);

export interface PasswordPolicyResult {
    ok: boolean;
    problems: string[];
}

/**
 * Enforced on WRITE, not merely declared on the schema — a policy that only exists in
 * a validator is bypassed by the bootstrap CLI, a seed script, or a future admin-reset
 * path. Every write goes through `hash()`, which calls this.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
    const problems: string[] = [];

    if (password.length < MIN_PASSWORD_LENGTH) {
        problems.push(`must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        problems.push(`must be at most ${MAX_PASSWORD_LENGTH} characters`);
    }
    if (FORBIDDEN_PASSWORDS.has(password.toLowerCase())) {
        problems.push('is too common');
    }
    if (/^(.)\1+$/.test(password)) {
        problems.push('cannot be a single repeated character');
    }

    return { ok: problems.length === 0, problems };
}

export async function hash(password: string): Promise<string> {
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) {
        throw createAppError(ERROR_CODES.ADMIN_AUTH_PASSWORD_WEAK, 422, undefined, {
            // ⚠ THE WIRE KEY IS `failedRules`, AND IT MUST NOT BE RENAMED BACK TO `problems`.
            //
            // `problems` is on `detail-policy.ts`'s always-dropped internal-key list, and
            // correctly so: it is the payload the nineteen boot-time assertions attach, a
            // full internal diagnostic naming permissions, actions and route paths. The
            // deny-list is keyed on the KEY NAME, not on where it was thrown, so attaching
            // the field under that name here silently deleted these four user-safe strings
            // at the boundary — an administrator got a bare refusal and no way to tell
            // which rule they broke, while the contract page promised the server names them.
            //
            // The local `PasswordPolicyResult.problems` keeps its name on purpose: it is an
            // internal shape read by the bootstrap CLI, never a wire key. This mapping is
            // the whole fix. Do not widen the deny-list to rescue the old name — that list
            // is what keeps the boot diagnostics from reaching a client.
            failedRules: policy.problems,
        });
    }
    return bcrypt.hash(password, BCRYPT_COST);
}

/** Verify a candidate against a stored hash. The caller MUST branch on the result. */
export async function verify(password: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(password, passwordHash);
}

/**
 * Spend a comparison on the account-not-found path so its timing matches a real
 * failure. Always resolves false; the return value exists only so a caller cannot
 * accidentally treat "no account" as success.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
}

/**
 * Used by the bootstrap CLI to mint a first password no human chose.
 * `randomInt` is rejection-sampled by Node, so the distribution is uniform — a
 * `Math.random() % n` would bias toward the start of the alphabet.
 */
export function generateStrongPassword(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
    let out = '';
    for (let i = 0; i < 24; i++) out += alphabet[randomInt(alphabet.length)];
    return out;
}

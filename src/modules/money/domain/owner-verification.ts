/**
 * "Has a human vetted this business?" — the KYC axis, read uniformly across the three
 * payable roles, for the one screen on this service where money leaves the platform.
 *
 * ── Why wi-admin computes this rather than forwarding it ─────────────────────
 *
 * jovi-mall added `verification` to `GET /api/internal/admin/payout-requests` on
 * 2026-09-15, and admin-dash asked for it to be carried through (BR-026 § 1). ⚠ **There is
 * nothing to carry through: the payout queue on this service is not a delegated call.**
 * `PayoutRequestReadRepository` reads `payout_requests` out of the shared jovi_mall
 * database directly — ADR-009 D-1's read side — so jovi-mall's DTO never passes through
 * here and its new field arrives on no wire.
 *
 * Two consequences, and the second is the useful one:
 *   - the verdict has to be resolved HERE, against the same three collections and by the
 *     same rule, which is what this file is;
 *   - it therefore works the moment this service ships, with no dependency on jovi-mall
 *     deploying. `kyc_details.status` and `kyc.status` have been written by the review
 *     endpoints since Phase 9 — the activation split changed what `status` means, not
 *     where the verdict lives.
 *
 * ── Why it is a copy, and what must stay identical ───────────────────────────
 *
 * This is the twin of jovi-mall's `src/core/accounts/verification.ts`. There is no shared
 * package between the three backends and there will not be one, so the two files are kept
 * byte-comparable in the parts that matter — the verdict union, the fail-closed default,
 * and the rule that `verified` is the only value any decision may test. A drift here is
 * silent in the dangerous direction: the two services would disagree about whether an
 * account is vetted, and the one that says "yes" is the one paying out.
 *
 * ⚠ **The three roles do NOT share a verdict vocabulary, and flattening them would lose
 * information a reviewer needs.** Vendor and agency default to `pending`; an agent defaults
 * to `unverified` and reaches `pending` only once documents are submitted. On an agent
 * those two words separate "nothing submitted" from "submitted, waiting" — which is what
 * tells a reviewer whether to chase someone for documents. Each role's own word is carried
 * through; only the boolean is branched on.
 *
 * ── Why it lives under `money/` ──────────────────────────────────────────────
 * The payout queue is its only consumer, and `core/` on this service is infrastructure —
 * data, errors, http, logging, validation — with no domain in it. If a second surface ever
 * needs a trust verdict (an account page badge is the likely one), this moves up rather
 * than being copied a third time.
 */

/** The union of all three roles' verdicts. Not every role can produce every value. */
export type VerificationVerdict = 'unverified' | 'pending' | 'verified' | 'rejected';

export interface OwnerVerification {
    /**
     * The only field a decision may branch on.
     *
     * ⚠ Deliberately NOT `verdict !== 'rejected'`. "Never reviewed" is not approval, and on
     * a young platform that is most accounts.
     */
    verified: boolean;
    /** The role's own word for where the review stands. For display, and for humans. */
    verdict: VerificationVerdict;
}

const KNOWN_VERDICTS: readonly string[] = ['unverified', 'pending', 'verified', 'rejected'];

/**
 * Read a verdict off whatever the role's KYC projection returned.
 *
 * ⚠ **Fails closed on everything it does not recognise** — a missing field, a projection
 * that omitted it, a status value some future role adds. The cost of the opposite mistake
 * is a reviewer releasing money against a badge that says "verified" because this function
 * did not know the word it was given.
 */
export function verificationOf(status: string | null | undefined): OwnerVerification {
    const verdict = (typeof status === 'string' && KNOWN_VERDICTS.includes(status)
        ? status
        : 'unverified') as VerificationVerdict;
    return { verified: verdict === 'verified', verdict };
}

/**
 * What an unresolvable owner reads as.
 *
 * A deleted row, a `platform` owner, an id that resolves in neither directory — none of
 * those is a vetted business, and a payout row must not render as one because its owner
 * could not be found.
 */
export const UNKNOWN_VERIFICATION: OwnerVerification = Object.freeze({
    verified: false,
    verdict: 'unverified',
});

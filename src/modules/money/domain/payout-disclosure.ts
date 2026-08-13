import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditIntent } from '../../audit/domain/audit.types';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import {
    PayoutDestinationDto,
    revealedMethodsOf,
    toRevealedDestinationDto,
} from '../read-models/payout-destination.dto';
import { PayoutDestinationReadRepository } from '../repositories/payout-request.read.repository';
import { labelOfPayout, loadPayoutOr404 } from './payout-dual-control';

/**
 * Revealing where a payout is addressed — the one READ in this service that writes an audit
 * row, and the only path that puts a beneficiary's account number on the wire.
 *
 * ── Why a read is audited at all ──────────────────────────────────────────────
 * "Reads are not actions" holds everywhere else here, and for a good reason: a read leaves
 * no state behind to reconstruct, so the permission gate is the entire control and a row per
 * read would be volume with nothing to say. This one breaks that in a specific way — **its
 * output is the material a fraudulent payout instruction is built from.** For a disclosure,
 * "who may" is not the interesting question; "who did, and how often" is. An administrator
 * who unmasks forty destinations in an hour is copying the payout roster, and nothing else
 * in this service would ever see it. `sensitive: true` follows automatically from the
 * permission's `financial` flag, which puts it on the alerting axis for free.
 *
 * ── Why `auditedAttempt`, and why that ordering is the whole design ───────────
 * The action's declared transport is `external` rather than `observation`, and the
 * difference is not bookkeeping. `observation` (`recordEvent`) is best-effort and swallows
 * a write failure — right for a login, which already happened on its own terms, and wrong
 * here, where **the audit row IS the control**. `auditedAttempt` commits the intent FIRST
 * and does not catch it, so with the audit store unreachable the disclosure simply never
 * runs. Fail-closed is the only acceptable posture for the one endpoint that emits a bank
 * account number, and it is exercised by hand in the phase plan's manual checklist.
 *
 * A crash between the intent and the answer leaves a row at `attempted` — the dangling
 * intent ADR-002 D4-a calls "itself a useful signal". Read conservatively, that row means
 * the value may have been disclosed.
 *
 * ── Why this is a domain file and not four lines in the controller ────────────
 * Every other audit intent in this module is built inside `gateways/money.gateway.ts`,
 * because every other audited action there is a delegated write and the gateway is the
 * transport boundary. This one delegates nothing — it is a direct read of `jovi_mall` — so
 * it has no gateway to live in, and putting the intent construction in the controller would
 * put the ordering rule above (audit, THEN disclose) in the one layer that is meant to be
 * thin. Same argument `payout-dual-control.ts` makes for itself.
 */

const destinations = new PayoutDestinationReadRepository();

/**
 * Reveal one payout's destination, and record that it was revealed.
 *
 * Order matters at every step and each one is load-bearing:
 *
 *   1. read the payout MASKED (404, and the label the audit row is recognised by). This
 *      also means a mistyped id never reaches the audit trail as an attempted disclosure —
 *      it is not one.
 *   2. commit the intent, and stop here if that fails.
 *   3. only now read the routing values, through the narrow projection.
 *   4. 422 if the payout carries no destination at all; the row stamps `failed` and the
 *      attempt stays on the record, which is the point — somebody asked.
 *   5. stamp `after` with which KINDS were revealed. Never the values: putting them there
 *      would move a beneficiary's account number into the one store that is readable
 *      without the permission gating it, and the audit trail would become the leak.
 */
export async function revealDestination(
    payoutId: string,
    context: ActorContext,
): Promise<PayoutDestinationDto> {
    const row = await loadPayoutOr404(payoutId);

    const intent: AuditIntent = {
        action: 'money.payouts.destination.read',
        actor: auditActorOf(context.actor),
        target: { type: 'payout', id: payoutId, label: labelOfPayout(row) },
        context,
        /**
         * Who the money is for, so the row reads without a join into the other database —
         * and nothing else. The amount is already in the label; the destination is the one
         * thing that must not be here.
         */
        payload: {
            payoutId,
            ownerType: row.owner_type,
            ownerId: row.owner_id.toString(),
        },
    };

    return auditedAttempt(intent, async () => {
        const found = await destinations.findById(payoutId);
        const destination = found ? toRevealedDestinationDto(found) : null;

        /**
         * 422, not 404. The payout exists — step 1 proved it — and this says the row carries
         * no `payout_method_snapshot`, which is what payouts predating the snapshot look
         * like. A dashboard that could not tell the two apart would show "no such payout"
         * for a payout it is displaying.
         */
        if (!destination) {
            throw createAppError(ERROR_CODES.PAYOUT_DESTINATION_ABSENT, 422);
        }

        return {
            result: destination,
            after: { revealedMethods: revealedMethodsOf(destination) },
        };
    });
}

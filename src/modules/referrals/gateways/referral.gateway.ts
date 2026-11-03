import { platformRequest } from '../../../infra/platform/platform.client';
import { auditedAttempt } from '../../audit/domain/audit.writer';
import { ActorContext } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AuditTargetType } from '../../audit/domain/audit.types';
import {
    OptionalReasonBody,
    RequiredReasonBody,
    UpdatePartnerTermsBody,
    UpdateSettingsBody,
} from '../validators/referral.validator';

/**
 * The referral program's WRITE half, reached over jovi-mall's `/api/internal/admin/referrals`.
 *
 * jovi-mall holds the status history a commission is judged by, generates the code and emails the
 * partner, so none of this is a field a second writer could set (ADR-004 D-2).
 *
 * ── Audited intent → outcome, fail-closed ─────────────────────────────────────
 * The intent row commits BEFORE the request, so with the audit store down nothing is changed.
 */

export type ReferralSnapshot = Record<string, unknown> | null;

export interface PlatformPartnerAck {
    id: string;
    status: string;
    code: string | null;
    canReapply: boolean;
    balanceReleased: boolean;
}

function audited<T>(
    action: AuditAction,
    target: { type: AuditTargetType; id: string | null; label: string | null },
    context: ActorContext,
    payload: Record<string, unknown> | null,
    before: ReferralSnapshot,
    perform: () => Promise<T>,
): Promise<T> {
    return auditedAttempt(
        {
            action,
            actor: {
                kind: 'administrator',
                id: context.actor.adminId,
                email: context.actor.email,
                displayName: context.actor.displayName,
                tier: context.actor.tier,
                sessionId: context.actor.sessionId,
            },
            target,
            context: {
                method: context.method,
                path: context.path,
                requestId: context.requestId,
                ip: context.ip,
                userAgent: context.userAgent,
            },
            payload,
        },
        async () => {
            const result = await perform();
            return { result, before, after: result as unknown as Record<string, unknown> };
        },
    );
}

async function send<T>(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>, context: ActorContext): Promise<T> {
    const result = await platformRequest<T>({ method, path, body, actor: context.actor, requestId: context.requestId });
    return result.data;
}

function partnerWrite(
    action: AuditAction,
    verb: string,
    partnerId: string,
    body: Record<string, unknown>,
    before: ReferralSnapshot,
    context: ActorContext,
): Promise<PlatformPartnerAck> {
    const label = typeof before?.code === 'string' ? before.code : null;
    return audited(action, { type: 'referral_partner', id: partnerId, label }, context, body, before, () =>
        send<PlatformPartnerAck>('POST', `/api/internal/admin/referrals/partners/${partnerId}/${verb}`, body, context),
    );
}

export const approve = (id: string, body: OptionalReasonBody, before: ReferralSnapshot, context: ActorContext) =>
    partnerWrite('referrals.partner.approve', 'approve', id, body, before, context);

export const reject = (id: string, body: RequiredReasonBody, before: ReferralSnapshot, context: ActorContext) =>
    partnerWrite('referrals.partner.reject', 'reject', id, body, before, context);

export const suspend = (id: string, body: RequiredReasonBody, before: ReferralSnapshot, context: ActorContext) =>
    partnerWrite('referrals.partner.suspend', 'suspend', id, body, before, context);

export const reinstate = (id: string, body: OptionalReasonBody, before: ReferralSnapshot, context: ActorContext) =>
    partnerWrite('referrals.partner.reinstate', 'reinstate', id, body, before, context);

export const terminate = (id: string, body: RequiredReasonBody, before: ReferralSnapshot, context: ActorContext) =>
    partnerWrite('referrals.partner.terminate', 'terminate', id, body, before, context);

export const allowReapply = (id: string, before: ReferralSnapshot, context: ActorContext) =>
    partnerWrite('referrals.partner.allow_reapply', 'allow-reapply', id, {}, before, context);

export const releaseBalance = (id: string, body: RequiredReasonBody, before: ReferralSnapshot, context: ActorContext) =>
    partnerWrite('referrals.partner.release_balance', 'release-balance', id, body, before, context);

export function updateTerms(id: string, body: UpdatePartnerTermsBody, before: ReferralSnapshot, context: ActorContext): Promise<PlatformPartnerAck> {
    const label = typeof before?.code === 'string' ? before.code : null;
    return audited('referrals.partner.terms_update', { type: 'referral_partner', id, label }, context, body, before, () =>
        send<PlatformPartnerAck>('PATCH', `/api/internal/admin/referrals/partners/${id}/terms`, body, context),
    );
}

export function updateSettings(body: UpdateSettingsBody, before: ReferralSnapshot, context: ActorContext): Promise<{ enabled: boolean }> {
    return audited('referrals.settings.update', { type: 'referral_settings', id: null, label: 'Referral settings' }, context, body, before, () =>
        send<{ enabled: boolean }>('PATCH', '/api/internal/admin/referrals/settings', body, context),
    );
}

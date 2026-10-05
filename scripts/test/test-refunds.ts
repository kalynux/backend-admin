/**
 * test:refunds — the refund queue (REFUND-FLOW-PLAN § 7, plan step R8). **No DB, no network.**
 *
 * What this pins, in order of how badly each regression would hurt:
 *
 *  1. **Who may do what.** Support reads and RAISES (which holds earnings) and never approves,
 *     settles or forgives; the one financial permission it holds is a named allowlist entry.
 *  2. **Four-eyes.** Approve and write-off queue at ≥ 2,000,000 with the amount off the ROW;
 *     a typed destination's approver must not be its requester (R-7), at any amount.
 *  3. **Fail-closed audit.** Every write commits its intent row before jovi-mall is called.
 *  4. **No proof byte touches this service.** The upload is a stream to jovi-mall's PRIVATE
 *     tree; never `/files/upload`, never a disk or buffer here.
 *  5. **The wire.** Masked list, full detail, no merchant reference, required-and-nullable.
 *
 * Run: npm run test:refunds
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
import { suite } from './_assert';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/refunds/routes/refund.routes';
import { PERMISSION_CATALOG, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { hasPermission } from '../../src/modules/authorization/domain/permission.resolver';
import { TIER_GRANTS, assertGrantTableValid } from '../../src/modules/authorization/domain/tier-grants';
import { AUDIT_CATALOG, auditSpec } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { dualControlRequired } from '../../src/modules/dual-control/domain/approval.service';
import { dualControlHandlerFor } from '../../src/modules/dual-control/domain/dual-control.registry';
import { ERROR_CODES } from '../../src/core/errors/error-codes';
import {
    REFUND_APPROVE_MODE,
    approvePayload,
    assertActionable,
    assertNotSelfApproval,
    relatedTargetOf,
    requestedByRoleFor,
} from '../../src/modules/refunds/domain/refund-actions';
import { ACTIONABLE_FROM, OPEN_REFUND_STATUSES } from '../../src/modules/refunds/domain/refund-vocabulary';
import {
    REFUND_REQUEST_PROJECTION,
    buildRefundRequestFilter,
} from '../../src/modules/refunds/repositories/refund-request.read.repository';
import { toRefundAuditState, toRefundRequestDto } from '../../src/modules/refunds/read-models/refund-request.dto';
import {
    ApproveRefundSchema,
    CreateRefundRequestSchema,
    ListRefundRequestsQuerySchema,
    RefundEligibilityQuerySchema,
    RejectRefundSchema,
    ResolveUnknownRefundSchema,
    RetryRefundSchema,
    SettleExternalRefundSchema,
} from '../../src/modules/refunds/validators/refund.validator';

const t = suite('refunds');

const SRC = join(__dirname, '..', '..', 'src');
const MODULE = join(SRC, 'modules', 'refunds');
/** jovi-mall's source, read as text for the cross-repo pins (never imported). */
const JOVI_SRC = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');
const read = (...segments: string[]) => readFileSync(join(...segments), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function moduleFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) moduleFiles(full, found);
        else if (entry.endsWith('.ts')) found.push(full);
    }
    return found;
}

const codeOf = (fn: () => unknown): string | null => {
    try {
        fn();
        return null;
    } catch (error) {
        return (error as { code?: string }).code ?? 'THREW';
    }
};

const ADMIN_ID = 'a'.repeat(24);
const OTHER_ADMIN_ID = 'b'.repeat(24);

function requestRow(overrides: Record<string, unknown> = {}) {
    return {
        _id: new ObjectId('c'.repeat(24)),
        source_kind: 'order',
        source_id: new ObjectId('d'.repeat(24)),
        order_number: 'WM-1001',
        vendor_id: new ObjectId('e'.repeat(24)),
        reason_kind: 'return',
        gross_amount: 5_000,
        fee_rate: 2,
        fee_amount: 100,
        net_amount: 4_900,
        currency: 'XAF',
        status: 'awaiting_approval',
        destination: { phone: '+237600124417', name: 'Ada', source: 'typed' },
        destination_proof_file_id: new ObjectId('f'.repeat(24)),
        requested_by: { id: ADMIN_ID, role: 'admin', name: 'Admin A' },
        created_at: new Date('2026-10-05T10:00:00.000Z'),
        ...overrides,
    } as never;
}

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The route manifest — one permission per verb');

const routes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/refunds'));
const route = (method: string, suffix: string) =>
    routes.find((r) => r.method === method && r.fullPath === `/api/v1/refunds${suffix}`);

const EXPECTED: Array<[string, string, string[], string | null]> = [
    ['get', '', ['orders.refund.read'], null],
    ['get', '/eligibility', ['orders.refund.request'], null],
    ['post', '/proofs', ['orders.refund.request'], 'orders.refund.proof.upload'],
    ['get', '/proofs/:fileId', ['orders.refund.read'], 'orders.refund.proof.read'],
    ['post', '', ['orders.refund.request'], 'orders.refund.request'],
    ['get', '/:refundId', ['orders.refund.read'], null],
    ['get', '/:refundId/activity', ['orders.refund.read', 'audit.read'], null],
    ['post', '/:refundId/approve', ['orders.refund'], 'orders.refund.approve'],
    ['post', '/:refundId/reject', ['orders.refund'], 'orders.refund.reject'],
    ['post', '/:refundId/retry', ['orders.refund'], 'orders.refund.retry'],
    ['post', '/:refundId/settle-external', ['orders.refund.settle_external'], 'orders.refund.settle_external'],
    ['post', '/:refundId/resolve-unknown', ['orders.refund'], 'orders.refund.resolve_unknown'],
];

t.assert(`exactly ${EXPECTED.length} routes are declared on /refunds`, () => routes.length === EXPECTED.length);

for (const [method, suffix, permissions, action] of EXPECTED) {
    const label = `${method.toUpperCase()} /refunds${suffix}`;
    t.assert(`${label} → ${permissions.join(' + ')}${action ? `, records ${action}` : ''}`, () => {
        const r = route(method, suffix === '' ? '' : suffix) ?? route(method, suffix === '' ? '/' : suffix);
        if (!r || r.access.kind !== 'permission') return false;
        const samePermissions = [...r.access.permissions].sort().join() === [...permissions].sort().join()
            && r.access.mode !== 'any';
        const sameAudit = action === null
            ? r.audit === null
            : r.audit?.kind === 'records' && r.audit.actions.length === 1 && r.audit.actions[0] === action;
        return samePermissions && sameAudit;
    });
}

t.assert('the literals /eligibility and /proofs are declared BEFORE /:refundId', () => {
    const at = (path: string, method = 'get') => routes.findIndex((r) => r.method === method && r.fullPath === `/api/v1/refunds${path}`);
    const detail = at('/:refundId');
    return at('/eligibility') >= 0 && at('/eligibility') < detail && at('/proofs/:fileId') < detail;
});

t.assert('no route file under refunds/ registers on the router directly', () =>
    !/\brouter\s*\.\s*(get|post|put|patch|delete|use)\s*\(/.test(stripComments(read(MODULE, 'routes', 'refund.routes.ts'))));

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. Permissions and tiers');

t.assert('the grant table is still valid', () => codeOf(() => assertGrantTableValid()) === null);

t.assert('orders.refund.read is an unflagged read held by every tier', () => {
    const spec = permissionSpec('orders.refund.read');
    return spec.action === 'read' && !spec.financial && [1, 2, 3].every((tier) => hasPermission(tier as 1, 'orders.refund.read'));
});

t.assert('orders.refund.request is FINANCIAL (it holds earnings) and held by every tier', () => {
    const spec = permissionSpec('orders.refund.request');
    return spec.financial === true && spec.action === 'write'
        && [1, 2, 3].every((tier) => hasPermission(tier as 1, 'orders.refund.request'));
});

t.assert('Support CANNOT approve, reject, retry, resolve, settle externally or write off', () =>
    !hasPermission(3, 'orders.refund')
    && !hasPermission(3, 'orders.refund.settle_external')
    && !hasPermission(3, 'money.earnings.clawback.write_off'));

t.assert('Admin and Developer hold every refund permission', () =>
    ([1, 2] as const).every((tier) =>
        (['orders.refund', 'orders.refund.read', 'orders.refund.request', 'orders.refund.settle_external', 'money.earnings.clawback.write_off'] as const)
            .every((name) => hasPermission(tier, name))));

t.assert('settle_external and write_off are financial', () =>
    permissionSpec('orders.refund.settle_external').financial === true
    && permissionSpec('money.earnings.clawback.write_off').financial === true);

t.assert('TIER_3_FINANCIAL_ALLOWLIST names orders.refund.request, beside money.payouts.triage', () => {
    const source = stripComments(read(SRC, 'modules', 'authorization', 'domain', 'tier-grants.ts'));
    const block = source.slice(source.indexOf('const TIER_3_FINANCIAL_ALLOWLIST'), source.indexOf('];', source.indexOf('const TIER_3_FINANCIAL_ALLOWLIST')));
    return block.includes("'money.payouts.triage'") && block.includes("'orders.refund.request'")
        && !block.includes("'orders.refund'") && !block.includes('settle_external');
});

t.assert('the financial permissions Support holds are exactly triage and refund.request', () => {
    const financial = TIER_GRANTS[3].filter((name) => permissionSpec(name).financial === true).sort();
    return financial.join() === 'money.payouts.triage,orders.refund.request';
});

t.assert('requestedByRole is derived from the caller: an approver is admin, Support is support', () =>
    requestedByRoleFor({ tier: 1 } as never) === 'admin'
    && requestedByRoleFor({ tier: 2 } as never) === 'admin'
    && requestedByRoleFor({ tier: 3 } as never) === 'support');

t.assert('the create body has NO requestedByRole — the caller cannot claim to be an admin', () =>
    !CreateRefundRequestSchema.safeParse({
        sourceKind: 'order', sourceId: 'd'.repeat(24), reasonKind: 'return', reason: 'damaged item', requestedByRole: 'admin',
    }).success);

t.assert('approveNow requires orders.refund, checked BEFORE the request is created', () => {
    const source = read(MODULE, 'domain', 'refund-actions.ts');
    const body = source.slice(source.indexOf('export async function createRequest'));
    return body.indexOf("denyUnless(actor, 'orders.refund'") > 0
        && body.indexOf("denyUnless(actor, 'orders.refund'") < body.indexOf('gateway.createRefundRequest(');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. Four-eyes');

t.assert('approve: orders.refund queues at ≥ 2,000,000, approved by orders.refund', () => {
    const spec = permissionSpec('orders.refund').dualControl;
    return spec !== undefined && spec.approverPermission === 'orders.refund'
        && dualControlRequired('orders.refund', { amount: 2_000_000 })
        && !dualControlRequired('orders.refund', { amount: 1_999_999 })
        && !dualControlRequired('orders.refund', { amount: '2000000' });
});

t.assert('write-off: queues at ≥ 2,000,000 too', () =>
    dualControlRequired('money.earnings.clawback.write_off', { amount: 2_000_000 })
    && !dualControlRequired('money.earnings.clawback.write_off', { amount: 1_999_999 }));

t.assert('the same line as LARGE_PAYOUT — one definition of "a lot of money"', () =>
    dualControlRequired('money.payouts.mark_paid', { amount: 2_000_000 })
    && !dualControlRequired('money.payouts.mark_paid', { amount: 1_999_999 }));

t.assert('the approve payload takes the amount off the ROW and carries its own mode', () => {
    const payload = approvePayload(requestRow({ gross_amount: 2_500_000 }));
    return payload.amount === 2_500_000 && payload.currency === 'XAF' && payload.mode === REFUND_APPROVE_MODE
        && payload.refundId === 'c'.repeat(24) && payload.destinationSource === 'typed';
});

t.assert('approving takes NO body (.strict() on {}): an `amount` key is a 400', () =>
    ApproveRefundSchema.safeParse({}).success && !ApproveRefundSchema.safeParse({ amount: 1_999_999 }).success);

t.assert('importing the routes registers the orders.refund handler, so the service can boot', () =>
    dualControlHandlerFor('orders.refund') !== undefined);

t.assert('the handler re-checks status, amount, currency and R-7, then acts as the APPROVER', () => {
    const source = read(MODULE, 'domain', 'refund-actions.ts');
    const handler = source.slice(source.indexOf("registerDualControlHandler('orders.refund'"));
    return handler.includes("assertActionable(row, 'approve')")
        && handler.includes('row.gross_amount !== approval.payload.amount')
        && handler.includes('row.currency !== approval.payload.currency')
        && handler.includes('assertNotSelfApproval(row, approver.adminId)')
        && handler.includes('actor: approver')
        && handler.includes('approval._id.toString()');
});

t.assert('the direct approve path refuses a doomed request BEFORE it can be queued', () => {
    const source = read(MODULE, 'domain', 'refund-actions.ts');
    const body = source.slice(source.indexOf('export async function approve'));
    const queued = body.indexOf('dualControlRequired(');
    return body.indexOf("assertActionable(row, 'approve')") < queued
        && body.indexOf('assertNotSelfApproval(row, actor.adminId)') < queued;
});

t.assert('R-7: the administrator who typed the number may not approve it', () =>
    codeOf(() => assertNotSelfApproval(requestRow(), ADMIN_ID)) === ERROR_CODES.REFUND_SECOND_APPROVER_REQUIRED);

t.assert('R-7: a different administrator may', () => codeOf(() => assertNotSelfApproval(requestRow(), OTHER_ADMIN_ID)) === null);

t.assert('R-7: a payer destination (not typed) may be approved by its requester', () =>
    codeOf(() => assertNotSelfApproval(requestRow({ destination: { phone: '+237600000000', name: 'X', source: 'payer' } }), ADMIN_ID)) === null);

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The status pre-flight');

t.assert('only resolve-unknown acts on `sending` — reject and settle-external never do', () =>
    (Object.entries(ACTIONABLE_FROM) as Array<[string, readonly string[]]>)
        .filter(([, from]) => from.includes('sending'))
        .map(([verb]) => verb).join() === 'resolveUnknown');

t.assert('reject only from awaiting_approval or failed', () => [...ACTIONABLE_FROM.reject].sort().join() === 'awaiting_approval,failed');
t.assert('settle-external from awaiting_approval, approved, waiting_for_cash and failed', () =>
    [...ACTIONABLE_FROM.settleExternal].sort().join() === 'approved,awaiting_approval,failed,waiting_for_cash');
t.assert('retry from approved (send refused before its claim) or failed; approve only from awaiting_approval', () =>
    [...ACTIONABLE_FROM.retry].sort().join() === 'approved,failed' && ACTIONABLE_FROM.approve.join() === 'awaiting_approval');
t.assert("retry's pre-flight matches jovi-mall's CLAIMABLE_STATUSES", () => {
    const status = readFileSync(join(JOVI_SRC, 'modules', 'payments', 'domain', 'refund-status.ts'), 'utf8');
    return /CLAIMABLE_STATUSES[^=]*=\s*Object\.freeze\(\['approved', 'failed'\]/.test(status);
});

t.assert('a sending request refuses reject with REFUND_REQUEST_STATUS_CONFLICT', () =>
    codeOf(() => assertActionable(requestRow({ status: 'sending' }), 'reject')) === ERROR_CODES.REFUND_REQUEST_STATUS_CONFLICT);

t.assert('the open queue is the five statuses the one-open-per-source index treats as open', () =>
    [...OPEN_REFUND_STATUSES].sort().join() === 'approved,awaiting_approval,failed,sending,waiting_for_cash');

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Audit — fail-closed, before the call');

const gatewaySource = stripComments(read(MODULE, 'gateways', 'refund.gateway.ts'));

t.assert('the shared write helper commits the intent (auditedAttempt) and calls jovi-mall INSIDE it', () => {
    const helper = gatewaySource.slice(gatewaySource.indexOf('function auditedRefundWrite'), gatewaySource.indexOf('export async function refundEligibility'));
    return helper.indexOf('auditedAttempt(') >= 0 && helper.indexOf('auditedAttempt(') < helper.indexOf('platformRequest');
});

t.assert('every exported write goes through the audited helper', () => {
    const writes = ['createRefundRequest', 'approveRefundRequest', 'rejectRefundRequest', 'retryRefundRequest', 'settleRefundExternally', 'resolveUnknownRefund'];
    return writes.every((name) => {
        const start = gatewaySource.indexOf(`export async function ${name}`);
        const next = gatewaySource.indexOf('export ', start + 10);
        const body = gatewaySource.slice(start, next === -1 ? undefined : next);
        return start >= 0 && body.includes('auditedRefundWrite(') && !body.includes('platformRequest');
    });
});

t.assert('the only bare platformRequest is the eligibility READ', () => {
    const outside = gatewaySource.replace(
        gatewaySource.slice(gatewaySource.indexOf('function auditedRefundWrite'), gatewaySource.indexOf('export async function refundEligibility')),
        '',
    );
    const calls = (outside.match(/platformRequest</g) ?? []).length;
    return calls === 1 && /method: 'GET',\s*path: '\/refunds\/eligibility'/.test(outside);
});

t.assert('the proof upload and the proof read are each wrapped in auditedAttempt', () => {
    const upload = gatewaySource.slice(gatewaySource.indexOf('export async function uploadRefundProof'), gatewaySource.indexOf('export interface RefundProofContent'));
    const open = gatewaySource.slice(gatewaySource.indexOf('export async function openRefundProof'));
    return upload.indexOf('auditedAttempt(') < upload.indexOf('platformUpload')
        && open.indexOf('auditedAttempt(') < open.indexOf('platformStream');
});

t.assert('the writer commits the intent row BEFORE perform(), and does not catch that write', () => {
    const writer = stripComments(read(SRC, 'modules', 'audit', 'domain', 'audit.writer.ts'));
    const body = writer.slice(writer.indexOf('export async function auditedAttempt'));
    const create = body.indexOf('AuditLogModel().create(');
    const tryAt = body.indexOf('try {');
    return create > 0 && create < tryAt && tryAt < body.indexOf('await perform()');
});

t.assert('no audit payload carries the typed phone (only whether one was typed)', () => {
    const create = gatewaySource.slice(gatewaySource.indexOf('export async function createRefundRequest'), gatewaySource.indexOf('export async function approveRefundRequest'));
    const payload = create.slice(create.indexOf("'orders.refund.request',"), create.indexOf("method: 'POST'"));
    return payload.includes('destinationTyped') && !/phone/.test(payload);
});

t.assert('the audit state never includes the destination phone', () => {
    const state = toRefundAuditState(requestRow()) ?? {};
    return !JSON.stringify(state).includes('600124417') && state.destinationSource === 'typed';
});

const REFUND_ACTIONS = [
    'orders.refund.request', 'orders.refund.approve', 'orders.refund.reject', 'orders.refund.retry',
    'orders.refund.resolve_unknown', 'orders.refund.settle_external',
] as const;

for (const action of REFUND_ACTIONS) {
    t.assert(`${action} is a delegated action filed against the refund`, () =>
        auditSpec(action).transport === 'delegated' && auditSpec(action).target === 'refund');
}

t.assert('each refund action is governed by the permission its route requires', () =>
    auditSpec('orders.refund.request').permission === 'orders.refund.request'
    && auditSpec('orders.refund.settle_external').permission === 'orders.refund.settle_external'
    && (['orders.refund.approve', 'orders.refund.reject', 'orders.refund.retry', 'orders.refund.resolve_unknown'] as const)
        .every((a) => auditSpec(a).permission === 'orders.refund'));

t.assert('opening a proof is an EXTERNAL audited read on the file; uploading is delegated', () =>
    auditSpec('orders.refund.proof.read').transport === 'external'
    && auditSpec('orders.refund.proof.read').target === 'file'
    && auditSpec('orders.refund.proof.upload').transport === 'delegated'
    && auditSpec('orders.refund.proof.upload').permission === 'orders.refund.request');

t.assert('a refund is a platform record — Support may read what was done to one', () => subjectClassOf('refund') === 'platform_record');

t.assert('the order or booking rides as the related target; billing has none', () =>
    relatedTargetOf(requestRow())?.type === 'order'
    && relatedTargetOf(requestRow({ source_kind: 'booking' }))?.type === 'booking'
    && relatedTargetOf(requestRow({ source_kind: 'plan_purchase' })) === null);

t.assert('the write-off actions exist, one per owner type', () =>
    ['vendor', 'agency', 'agent'].every((type) => `money.earnings.clawback.write_off_${type}` in AUDIT_CATALOG));

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Proof pictures — streamed to the PRIVATE tree, never stored here');

const moduleSources = moduleFiles(MODULE).map((file) => ({ file, code: stripComments(readFileSync(file, 'utf8')) }));

t.assert('the refunds module was scanned (a silent zero would be a false green)', () => moduleSources.length >= 7);

t.assert('no multipart parser, no filesystem, no temp file, no buffering of the body', () =>
    moduleSources.every(({ code }) =>
        !/\b(multer|busboy|formidable)\b/.test(code)
        && !/from ['"](fs|fs\/promises|os)['"]/.test(code)
        && !/\b(writeFile|createWriteStream|mkdtemp|tmpdir)\b/.test(code)
        && !/Buffer\.concat/.test(code)));

t.assert('the upload targets /refunds/proofs through platformUpload — NEVER /files/upload', () =>
    /platformUpload<UploadedRefundProof>\(\{\s*path: '\/refunds\/proofs'/.test(gatewaySource)
    && moduleSources.every(({ code }) => !code.includes('/files/upload')));

t.assert('the upload passes the inbound request as the body (piped, unread)', () =>
    /uploadRefundProof\(\{ body: req, contentType, contentLength \}/.test(stripComments(read(MODULE, 'controllers', 'refund.controller.ts'))));

t.assert('a proof is served only when a refund request names it, checked BEFORE the audit row', () => {
    const controller = stripComments(read(MODULE, 'controllers', 'refund.controller.ts'));
    const body = controller.slice(controller.indexOf('static openProof'));
    return body.indexOf('findByProofFile(fileId)') > 0 && body.indexOf('findByProofFile(fileId)') < body.indexOf('openRefundProof(');
});

t.assert('proof bytes are never cached by an intermediary', () =>
    read(MODULE, 'controllers', 'refund.controller.ts').includes("'Cache-Control', 'private, no-store'"));

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Request shapes');

const createBase = { sourceKind: 'order', sourceId: 'd'.repeat(24), reasonKind: 'return', reason: 'item arrived broken' };

t.assert('create: minimal body accepted', () => CreateRefundRequestSchema.safeParse(createBase).success);
t.assert('create: a TYPED destination without its proof is refused (R-7)', () =>
    !CreateRefundRequestSchema.safeParse({ ...createBase, destination: { phone: '+237 600 124 417', name: 'Ada' } }).success);
t.assert('create: a typed destination WITH its proof is accepted, the phone normalised', () => {
    const parsed = CreateRefundRequestSchema.safeParse({
        ...createBase, destination: { phone: '+237 600 124 417', name: 'Ada' }, destinationProofFileId: 'f'.repeat(24),
    });
    return parsed.success && parsed.data.destination?.phone === '+237600124417';
});
t.assert('create: a non-international typed number is refused', () =>
    !CreateRefundRequestSchema.safeParse({
        ...createBase, destination: { phone: '600124417', name: 'Ada' }, destinationProofFileId: 'f'.repeat(24),
    }).success);
t.assert('create: a proof with no typed destination is refused', () =>
    !CreateRefundRequestSchema.safeParse({ ...createBase, destinationProofFileId: 'f'.repeat(24) }).success);
t.assert('create: amount is whole and positive; an unknown key is a 400', () =>
    !CreateRefundRequestSchema.safeParse({ ...createBase, amount: 0 }).success
    && !CreateRefundRequestSchema.safeParse({ ...createBase, amount: 10.5 }).success
    && !CreateRefundRequestSchema.safeParse({ ...createBase, gross: 1 }).success);
t.assert('reject needs a reason; retry takes no body', () =>
    !RejectRefundSchema.safeParse({}).success && RejectRefundSchema.safeParse({ reason: 'not owed' }).success
    && RetryRefundSchema.safeParse({}).success && !RetryRefundSchema.safeParse({ amount: 1 }).success);
t.assert('settle-external REQUIRES the proof picture (R-7b)', () =>
    !SettleExternalRefundSchema.safeParse({ method: 'cash' }).success
    && SettleExternalRefundSchema.safeParse({ method: 'cash', proofFileId: 'f'.repeat(24) }).success
    && !SettleExternalRefundSchema.safeParse({ method: 'covered_by_order_refund', proofFileId: 'f'.repeat(24) }).success);
t.assert('resolve-unknown: arrived or failed, with a note of at least 10 characters', () =>
    ResolveUnknownRefundSchema.safeParse({ outcome: 'arrived', note: 'provider statement line 42' }).success
    && !ResolveUnknownRefundSchema.safeParse({ outcome: 'paid', note: 'provider statement line 42' }).success
    && !ResolveUnknownRefundSchema.safeParse({ outcome: 'failed', note: 'short' }).success);
t.assert('create: destination.name is optional; ticketId and overridePolicy pass through', () => {
    const parsed = CreateRefundRequestSchema.safeParse({
        ...createBase, destination: { phone: '+237 600 124 417' }, destinationProofFileId: 'f'.repeat(24),
        ticketId: 'e'.repeat(24), overridePolicy: true,
    });
    return parsed.success && parsed.data.destination?.name === undefined
        && parsed.data.ticketId === 'e'.repeat(24) && parsed.data.overridePolicy === true;
});
t.assert('create: overridePolicy is NEVER set by this service (the gateway forwards only what was sent)', () => {
    const gw = stripComments(read(MODULE, 'gateways', 'refund.gateway.ts'));
    return gw.includes('...(input.overridePolicy !== null && { overridePolicy: input.overridePolicy })')
        && !/overridePolicy:\s*true/.test(gw);
});
t.assert('eligibility: the three optional steering keys are accepted (strings from a query)', () => {
    const parsed = RefundEligibilityQuerySchema.safeParse({
        sourceKind: 'order', sourceId: 'd'.repeat(24), reasonKind: 'return', itemDefective: 'true', amount: '5000',
    });
    return parsed.success && parsed.data.itemDefective === true && parsed.data.amount === 5000
        && !RefundEligibilityQuerySchema.safeParse({ sourceKind: 'order', sourceId: 'd'.repeat(24), amount: '50.5' }).success;
});
t.assert("eligibility: the gateway forwards ONLY jovi-mall's five strict keys", () => {
    const gw = read(MODULE, 'gateways', 'refund.gateway.ts');
    const body = gw.slice(gw.indexOf('export async function refundEligibility'), gw.indexOf('// The writes'));
    const keys = [...body.matchAll(/forwarded\.(\w+) =/g)].map((m) => m[1]);
    return body.includes('query: forwarded') && keys.sort().join() === 'amount,itemDefective,reasonKind';
});
t.assert("eligibility: jovi-mall's query is strict on exactly those keys", () => {
    const v = readFileSync(join(JOVI_SRC, 'modules', 'payments', 'validators', 'admin-refund-request.validator.ts'), 'utf8');
    const block = v.slice(v.indexOf('AdminRefundEligibilityQuerySchema'));
    return ['sourceKind', 'sourceId', 'reasonKind', 'itemDefective', 'amount'].every((k) => block.includes(`${k}`))
        && block.slice(0, block.indexOf('.strict()')).length > 0;
});
t.assert('list: status is the contract vocabulary; an unknown status is a 400', () =>
    ListRefundRequestsQuerySchema.safeParse({ status: 'waiting_for_cash' }).success
    && !ListRefundRequestsQuerySchema.safeParse({ status: 'pending' }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. The wire and the read');

const list = toRefundRequestDto(requestRow(), 'list');
const detail = toRefundRequestDto(requestRow(), 'detail', 'Chez Ada');

t.assert('the LIST masks the destination phone', () => list.destination?.phone === '+2376••••4417');
t.assert('the DETAIL shows it in full — the approver compares it with the proof', () => detail.destination?.phone === '+237600124417');
t.assert('secondApproverRequired is derived from a typed destination', () =>
    detail.secondApproverRequired === true
    && toRefundRequestDto(requestRow({ destination: { phone: '+237600000000', name: 'X', source: 'payer' } }), 'list').secondApproverRequired === false);
t.assert('earningsImpact is projected, and defaults to clawback on an older row', () =>
    toRefundRequestDto(requestRow({ earnings_impact: 'none' }), 'detail').earningsImpact === 'none'
    && toRefundRequestDto(requestRow(), 'detail').earningsImpact === 'clawback'
    && Object.keys(REFUND_REQUEST_PROJECTION).includes('earnings_impact'));
t.assert('money is gross / fee / net, and the vendor name rides along', () =>
    detail.grossAmount === 5_000 && detail.feeAmount === 100 && detail.netAmount === 4_900 && detail.vendor.name === 'Chez Ada');

function undefinedPaths(value: unknown, path = ''): string[] {
    if (value === null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((item, i) => undefinedPaths(item, `${path}[${i}]`));
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        child === undefined ? [`${path}.${key}`] : undefinedPaths(child, `${path}.${key}`));
}

t.assert('earningsSettledAt / billingReversedAt are projected (null until stamped)', () => {
    const at = new Date('2026-10-05T12:00:00Z');
    const stamped = toRefundRequestDto(requestRow({ earnings_settled_at: at, billing_reversed_at: at }), 'detail');
    const keys = Object.keys(REFUND_REQUEST_PROJECTION);
    return stamped.earningsSettledAt === at.toISOString() && stamped.billingReversedAt === at.toISOString()
        && toRefundRequestDto(requestRow(), 'detail').earningsSettledAt === null
        && keys.includes('earnings_settled_at') && keys.includes('billing_reversed_at');
});
t.assert('externalSettlement carries the hand-paid part, falling back to the request totals on an older row', () => {
    const base = { method: 'cash', reference: null, proof_file_id: new ObjectId(), settled_by: { id: 'a', name: 'A' }, settled_at: new Date() };
    const remainder = toRefundRequestDto(requestRow({ external_settlement: { ...base, gross_amount: 2_000, net_amount: 1_960 } }), 'detail');
    const legacy = toRefundRequestDto(requestRow({ external_settlement: base }), 'detail');
    const keys = Object.keys(REFUND_REQUEST_PROJECTION);
    return remainder.externalSettlement?.grossAmount === 2_000 && remainder.externalSettlement?.netAmount === 1_960
        && legacy.externalSettlement?.grossAmount === 5_000 && legacy.externalSettlement?.netAmount === 4_900
        && keys.includes('external_settlement.gross_amount') && keys.includes('external_settlement.net_amount');
});
t.assert("billing refunds are FULL only: amount is refused for plan_purchase / credit_topup (jovi-mall's billing_full_refund_only)", () =>
    !CreateRefundRequestSchema.safeParse({ ...createBase, sourceKind: 'plan_purchase', amount: 1000 }).success
    && !CreateRefundRequestSchema.safeParse({ ...createBase, sourceKind: 'credit_topup', amount: 1000 }).success
    && CreateRefundRequestSchema.safeParse({ ...createBase, sourceKind: 'plan_purchase' }).success
    && CreateRefundRequestSchema.safeParse({ ...createBase, amount: 1000 }).success
    && readFileSync(join(JOVI_SRC, 'modules', 'payments', 'services', 'refund-request.service.ts'), 'utf8')
        .includes("reason: 'billing_full_refund_only'"));
t.assert('the earnings-pause holder mirrors jovi-mall: open, else completed clawback not yet settled', () => {
    const repo = read(MODULE, 'repositories', 'refund-request.read.repository.ts');
    const body = repo.slice(repo.indexOf('async findHoldingEarningsPause'), repo.indexOf('async openForOrders'));
    const jovi = readFileSync(join(JOVI_SRC, 'modules', 'payments', 'services', 'refund-request.service.ts'), 'utf8');
    const joviBody = jovi.slice(jovi.indexOf('async findHoldingEarningsPause'), jovi.indexOf('async describeSource'));
    return ['OPEN_REFUND_STATUSES', "status: 'completed'", "earnings_impact: 'clawback'", 'earnings_settled_at: null'].every((n) => body.includes(n))
        && ["status: 'completed'", "earnings_impact: 'clawback'", 'earnings_settled_at: null'].every((n) => joviBody.includes(n));
});
t.assert('a minimal row maps with no undefined anywhere (required-and-nullable)', () => {
    const minimal = toRefundRequestDto({
        _id: new ObjectId(), source_kind: 'booking', source_id: new ObjectId(), reason_kind: 'cancellation',
        gross_amount: 1000, currency: 'XAF', status: 'awaiting_approval', created_at: new Date(),
    } as never, 'detail');
    return undefinedPaths(minimal).length === 0 && minimal.netAmount === 1000 && minimal.destination === null
        && minimal.approvedBy === null && minimal.externalSettlement === null;
});

t.assert('our merchant transfer reference is never projected', () => {
    const keys = Object.keys(REFUND_REQUEST_PROJECTION);
    return !keys.includes('transfer_reference') && !keys.includes('transfer_legs.reference') && !keys.includes('transfer_legs')
        && keys.includes('transfer_gateway_ref');
});

t.assert('?open=true filters the five open statuses; an explicit status wins', () => {
    const open = JSON.stringify(buildRefundRequestFilter({ open: true } as never));
    const explicit = JSON.stringify(buildRefundRequestFilter({ open: true, status: 'completed' } as never));
    return open.includes('awaiting_approval') && open.includes('$in') && explicit === '{"status":"completed"}';
});

t.assert('filters compose with $and, and a malformed id matches nothing', () => {
    const filter = buildRefundRequestFilter({ vendorId: 'nope', requesterRole: 'support' } as never) as Record<string, unknown>;
    return Array.isArray(filter.$and) && JSON.stringify(filter).includes('"$in":[]');
});

t.assert('refunds read refund_requests through PlatformReadRepository only — no write method', () => {
    const repo = read(MODULE, 'repositories', 'refund-request.read.repository.ts');
    return repo.includes('extends PlatformReadRepository<RefundRequestReadModel>')
        && !/insertOne|updateOne|deleteOne|PlatformOwnedRepository/.test(stripComments(repo));
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('9. Error codes');

for (const code of ['REFUND_REQUEST_STATUS_CONFLICT', 'REFUND_SECOND_APPROVER_REQUIRED', 'EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT'] as const) {
    t.assert(`${code} is registered under the same name jovi-mall uses`, () => ERROR_CODES[code] === code);
}

t.assert('the catalog flags are coherent: request financial, read not', () =>
    (PERMISSION_CATALOG['orders.refund.request'] as { financial?: boolean }).financial === true
    && (PERMISSION_CATALOG['orders.refund.read'] as { financial?: boolean }).financial !== true);

process.exit(t.finish());

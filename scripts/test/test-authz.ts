/**
 * Authorization — the policy itself, with no infrastructure.
 *
 * Everything asserted here is a pure function of code: the catalog, the grant table, the
 * escalation rules, the scope resolver, the route manifest. No Mongo, no Redis, no HTTP.
 * `verify-authz-live.ts` covers the same rules through the wire.
 *
 *   npm run test:authz
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { suite, throws } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { ERROR_CODES } from '../../src/core/errors/error-codes';
import { AppError, createAppError } from '../../src/core/errors/app-error';
import { AdminIdentity, AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import {
    PERMISSION_CATALOG,
    PERMISSION_NAMES,
    PermissionName,
    isPermissionName,
    permissionSpec,
} from '../../src/modules/authorization/domain/permission.catalog';
import { PERMISSION_FAMILIES, isSensitive } from '../../src/modules/authorization/domain/permission.types';
import { TIER_GRANTS, allInFamily, assertGrantTableValid } from '../../src/modules/authorization/domain/tier-grants';
import {
    effectivePermissions,
    grantedTo,
    hasAllPermissions,
    hasAnyPermission,
    hasPermission,
    missingPermissions,
} from '../../src/modules/authorization/domain/permission.resolver';
import { assertMayActOn, assertMayCreate, mayActOn } from '../../src/modules/authorization/domain/escalation.rules';
import { isTicketInScope, resolveScope } from '../../src/modules/authorization/domain/resource-scope';
import {
    AuthorizationDenial,
    recordAuthorizationDenial,
    resetDenialSink,
    setDenialSink,
} from '../../src/modules/authorization/domain/denial.recorder';
// `LEGACY_ENDPOINT_COUNT` and `LEGACY_ENDPOINT_MAP` were imported here. Both are DELETED
// (Phase 5 Part D), so § 9 below asserts their absence rather than their contents — see the
// section header for why the assertions were restated rather than dropped.
import { approvalRequestKey, canonicalJson } from '../../src/modules/dual-control/domain/action-key';
import { dualControlRequired } from '../../src/modules/dual-control/domain/approval.service';
import { NO_AUDIT_ROUTE_ALLOWLIST, PUBLIC_ROUTE_ALLOWLIST } from '../../src/api/route-manifest';
// § 9's two "it went with the module" checks. Imported here rather than asserted in
// `test:devtools` / `test:contract` because the fact being pinned is the DELETION, and it
// belongs beside the deletion it followed from.
import { FEATURE_FLAG_CATALOG } from '../../src/modules/dev-tools/domain/feature-flag.catalog';

const t = suite('authorization');

/** The `AppError.code` a throwing call produced, or null if it did not throw. */
function codeOf(fn: () => unknown): string | null {
    try {
        fn();
        return null;
    } catch (error) {
        return error instanceof AppError ? error.code : null;
    }
}

function identity(adminId: string, tier: AdminTier): AdminIdentity {
    return {
        adminId,
        sessionId: `sess-${adminId}`,
        email: `${adminId}@example.test`,
        displayName: adminId,
        tier,
        status: 'active',
        mfaEnrolled: true,
        pendingMfaEnrolment: false,
    pendingActivation: false,
        authenticatedAt: new Date(),
        sessionExpiresAt: new Date(Date.now() + 3_600_000),
        authMethod: 'cookie',
        ip: '127.0.0.1',
    };
}

const DEV = { adminId: 'dev-a', tier: 1 as AdminTier };
const DEV_B = { adminId: 'dev-b', tier: 1 as AdminTier };
const ADMIN = { adminId: 'admin-a', tier: 2 as AdminTier };
const ADMIN_B = { adminId: 'admin-b', tier: 2 as AdminTier };
const SUPPORT = { adminId: 'support-a', tier: 3 as AdminTier };

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. Catalog integrity');

t.assert('the catalog is not empty', () => PERMISSION_NAMES.length > 0);

t.assert('every name is family.resource.action or family.action', () =>
    PERMISSION_NAMES.every((name) => {
        const segments = name.split('.');
        return segments.length >= 2 && segments.length <= 4;
    }));

t.assert('every name begins with its declared family', () =>
    PERMISSION_NAMES.every((name) => name.startsWith(`${permissionSpec(name).family}.`)));

t.assert('every declared family is in PERMISSION_FAMILIES', () =>
    PERMISSION_NAMES.every((name) => PERMISSION_FAMILIES.includes(permissionSpec(name).family)));

t.assert('every permission has a non-empty summary', () =>
    PERMISSION_NAMES.every((name) => permissionSpec(name).summary.trim().length > 10));

t.assert('no duplicate names', () => new Set(PERMISSION_NAMES).size === PERMISSION_NAMES.length);

t.assert('isPermissionName accepts a real name', () => isPermissionName('cod.remittances.confirm'));
t.assert('isPermissionName rejects a typo', () => !isPermissionName('cod.remittances.confrim'));
t.assert('isPermissionName rejects a prototype key', () => !isPermissionName('toString'));

t.assert('every family in PERMISSION_FAMILIES has at least one permission', () =>
    PERMISSION_FAMILIES.every((family) =>
        PERMISSION_NAMES.some((name) => permissionSpec(name).family === family)));

/**
 * `financial` used to imply `write`, and Phase 11 broke that on purpose.
 *
 * `money.payouts.destination.read` reveals a beneficiary's account number. It moves no
 * money, so on the old rule it could not carry the flag — and without the flag
 * `allInFamily('money')` sweeps it into every tier including Support, which is the one
 * outcome nobody wants. The flag is right; the invariant was too narrow.
 *
 * So the assertion becomes an ALLOWLIST rather than a blanket ban, matching
 * `PUBLIC_ROUTE_ALLOWLIST`: a financial read is legal only if it is named here, which
 * makes adding one a two-file change that shows up in a diff as exactly that. An
 * ACCIDENTAL `financial: true` on a read — the real thing this guards — still fails.
 */
const FINANCIAL_READ_ALLOWLIST: ReadonlySet<string> = new Set([
    'money.payouts.destination.read',
]);

t.assert('every financial permission is a write, or an allowlisted disclosure', () =>
    PERMISSION_NAMES.filter((name) => permissionSpec(name).financial)
        .every((name) => permissionSpec(name).action === 'write'
            || FINANCIAL_READ_ALLOWLIST.has(name)));

t.assert('every allowlisted financial read actually exists and is still flagged', () =>
    [...FINANCIAL_READ_ALLOWLIST].every((name) =>
        isPermissionName(name) && permissionSpec(name).financial === true));

/**
 * The reason the flag was reached for in the first place: it is what keeps the name out
 * of a wildcard grant. If `allInFamily` ever started expanding it, the disclosure would
 * land in Support's grant silently.
 */
t.assert('an allowlisted financial read is NOT swept in by allInFamily', () =>
    !allInFamily('money').includes('money.payouts.destination.read'));

/**
 * The escalation flag is the narrowest in the catalog, and it must stay narrow.
 *
 * It means "this acts on the thing that decides who may act", confines the permission to
 * tier 1 at boot, and keeps it out of `allInFamily`. Phase 12 added the second member:
 * `administrators.mfa.reset` clears the strongest control on the most privileged accounts,
 * on an account nobody can currently authenticate as — the exact shape of a
 * social-engineering target.
 *
 * Named explicitly rather than counted loosely, so a third one is a deliberate edit here
 * rather than a number quietly going up.
 */
const ESCALATION_PERMISSIONS: readonly string[] = [
    'administrators.tier.set',
    'administrators.mfa.reset',
    /**
     * ADR-023 added the third, and it is the first whose reason is NOT that the act itself is
     * privileged.
     *
     * Activating a pending administrator merely lets them hold the level they were already
     * created at, under `assertMayCreate`. The flag is here because activation REQUIRES
     * READING THE EMPLOYEE RECORD, which is tier 1 (`employees.read`) — so an Admin able to
     * activate would be admitting a person whose file they cannot open, which is a rubber
     * stamp rather than a decision. The flag confines it to tier 1 and keeps it out of
     * `allInFamily('administrators')`, which tier 2 holds.
     */
    'administrators.activate',
];

t.assert('exactly the three named escalation permissions exist', () => {
    const escalation = PERMISSION_NAMES.filter((name) => permissionSpec(name).escalation);
    return escalation.length === ESCALATION_PERMISSIONS.length
        && ESCALATION_PERMISSIONS.every((name) => escalation.includes(name as PermissionName));
});

t.assert('every escalation permission is held by tier 1 and by nobody else', () =>
    ESCALATION_PERMISSIONS.every((name) =>
        hasPermission(1, name as PermissionName)
        && !hasPermission(2, name as PermissionName)
        && !hasPermission(3, name as PermissionName)));

/** The other half of the flag's job: a family grant must not sweep it in. */
t.assert('no escalation permission is expanded by allInFamily', () =>
    ESCALATION_PERMISSIONS.every((name) =>
        !allInFamily(permissionSpec(name as PermissionName).family).includes(name as PermissionName)));

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. Grant table');

t.assert('the shipped grant table is valid', () => codeOf(() => assertGrantTableValid()) === null);

t.assert('every permission is granted to at least one tier', () => {
    const granted = new Set<string>([...TIER_GRANTS[1], ...TIER_GRANTS[2], ...TIER_GRANTS[3]]);
    return PERMISSION_NAMES.every((name) => granted.has(name));
});

t.assert('every granted name exists in the catalog', () =>
    ([1, 2, 3] as AdminTier[]).every((tier) => TIER_GRANTS[tier].every((name) => isPermissionName(name))));

t.assert('no tier lists a permission twice', () =>
    ([1, 2, 3] as AdminTier[]).every((tier) => new Set(TIER_GRANTS[tier]).size === TIER_GRANTS[tier].length));

t.assert('tier 1 holds every permission', () => grantedTo(1).size === PERMISSION_NAMES.length);

t.assert('privilege nests: tier 3 ⊆ tier 2 ⊆ tier 1', () =>
    TIER_GRANTS[3].every((name) => grantedTo(2).has(name))
    && TIER_GRANTS[2].every((name) => grantedTo(1).has(name)));

t.assert('tier 3 holds no financial permission', () =>
    TIER_GRANTS[3].every((name) => permissionSpec(name).financial !== true));

t.assert('tier 3 holds no destructive permission', () =>
    TIER_GRANTS[3].every((name) => permissionSpec(name).destructive !== true));

t.assert('only tier 1 holds an escalation permission', () =>
    ([2, 3] as AdminTier[]).every((tier) =>
        TIER_GRANTS[tier].every((name) => permissionSpec(name).escalation !== true)));

t.assert('only tier 1 holds developer_tools', () =>
    ([2, 3] as AdminTier[]).every((tier) =>
        TIER_GRANTS[tier].every((name) => permissionSpec(name).family !== 'developer_tools')));

t.assert('every dualControl approverPermission exists', () =>
    PERMISSION_NAMES.every((name) => {
        const spec = permissionSpec(name).dualControl;
        return spec === undefined || isPermissionName(spec.approverPermission);
    }));

// ── The rule that makes wildcards safe ──
t.assert('allInFamily NEVER returns a sensitive permission', () =>
    PERMISSION_FAMILIES.every((family) =>
        allInFamily(family).every((name) => !isSensitive(permissionSpec(name)))));

t.assert('allInFamily returns only members of that family', () =>
    PERMISSION_FAMILIES.every((family) =>
        allInFamily(family).every((name) => permissionSpec(name).family === family)));

t.assert('allInFamily(cod) omits every confirm/reject/adjust write', () => {
    const expanded = allInFamily('cod');
    return !expanded.includes('cod.remittances.confirm')
        && !expanded.includes('cod.deposits.create')
        && !expanded.includes('cod.trust.adjust')
        && expanded.includes('cod.overview.read');
});

t.assert('allInFamily(administrators) omits tier.set and suspend', () => {
    const expanded = allInFamily('administrators');
    return !expanded.includes('administrators.tier.set')
        && !expanded.includes('administrators.suspend')
        && expanded.includes('administrators.read');
});

t.assert('allInFamily narrows by action', () =>
    allInFamily('cod', 'read').every((name) => permissionSpec(name).action === 'read'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. Resolution');

t.assert('Support lacks an Admin-only permission', () => !hasPermission(3, 'cod.remittances.confirm'));
t.assert('Admin holds it', () => hasPermission(2, 'cod.remittances.confirm'));
t.assert('Developer holds it', () => hasPermission(1, 'cod.remittances.confirm'));

t.assert('Support lacks administrators.read', () => !hasPermission(3, 'administrators.read'));
t.assert('Admin lacks administrators.tier.set', () => !hasPermission(2, 'administrators.tier.set'));
t.assert('Developer holds administrators.tier.set', () => hasPermission(1, 'administrators.tier.set'));

t.assert('Support holds its ticket surface', () =>
    hasPermission(3, 'support.tickets.read') && hasPermission(3, 'support.tickets.update'));

t.assert('Admin lacks files.delete — unrecoverable', () => !hasPermission(2, 'files.delete'));
t.assert('Admin lacks users.roles.manage', () => !hasPermission(2, 'users.roles.manage'));
t.assert('Admin lacks every developer tool', () => !hasPermission(2, 'developer_tools.outbox.replay'));

t.assert('hasAllPermissions requires all', () =>
    hasAllPermissions(2, ['cod.overview.read', 'cod.remittances.confirm'])
    && !hasAllPermissions(3, ['support.tickets.read', 'cod.remittances.confirm']));

t.assert('hasAnyPermission requires one', () =>
    hasAnyPermission(3, ['support.tickets.read', 'cod.remittances.confirm'])
    && !hasAnyPermission(3, ['files.delete', 'cod.remittances.confirm']));

t.assert('missingPermissions names only what is missing', () => {
    const missing = missingPermissions(3, ['support.tickets.read', 'cod.remittances.confirm']);
    return missing.length === 1 && missing[0] === 'cod.remittances.confirm';
});

t.assert('effectivePermissions is sorted and complete', () => {
    const effective = effectivePermissions(3);
    const sorted = [...effective].sort();
    return effective.length === grantedTo(3).size && effective.every((name, i) => name === sorted[i]);
});

t.assert('grantedTo returns the same set object each call — built once', () => grantedTo(2) === grantedTo(2));

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. Escalation rules');

// ── Rule 1: never act on yourself ──
t.assert('an Admin cannot suspend themselves', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: ADMIN.adminId, tier: 2 }, 'suspend'))
    === ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN);

t.assert('a Developer cannot suspend themselves', () =>
    codeOf(() => assertMayActOn(DEV, { adminId: DEV.adminId, tier: 1 }, 'suspend'))
    === ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN);

t.assert('a Developer cannot demote themselves — no self-inflicted lockout', () =>
    codeOf(() => assertMayActOn(DEV, { adminId: DEV.adminId, tier: 1 }, 'set_tier', { newTier: 3 }))
    === ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN);

t.assert('nobody may revoke their own sessions through this surface', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: ADMIN.adminId, tier: 2 }, 'revoke_sessions'))
    === ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN);

t.assert('nobody may reset their own password through this surface', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: ADMIN.adminId, tier: 2 }, 'reset_password'))
    === ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN);

t.assert('editing your OWN profile is allowed', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: ADMIN.adminId, tier: 2 }, 'update')) === null);

// ── Rule 2: never act on an equal or more privileged administrator ──
t.assert('an Admin cannot suspend a Developer', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: DEV.adminId, tier: 1 }, 'suspend'))
    === ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED);

t.assert('an Admin cannot suspend another Admin — peers are protected', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: ADMIN_B.adminId, tier: 2 }, 'suspend'))
    === ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED);

t.assert('an Admin CAN suspend a Support administrator', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: SUPPORT.adminId, tier: 3 }, 'suspend')) === null);

t.assert('a Support administrator cannot act on anyone', () =>
    codeOf(() => assertMayActOn(SUPPORT, { adminId: 'other', tier: 3 }, 'suspend'))
    === ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED);

t.assert('a Developer CAN act on an Admin', () =>
    codeOf(() => assertMayActOn(DEV, { adminId: ADMIN.adminId, tier: 2 }, 'suspend')) === null);

t.assert('an Admin cannot revoke a peer’s sessions', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: ADMIN_B.adminId, tier: 2 }, 'revoke_sessions'))
    === ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED);

t.assert('an Admin cannot reset a Developer’s password', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: DEV.adminId, tier: 1 }, 'reset_password'))
    === ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED);

// ── Rule 3: Developer on Developer, with a second Developer ──
t.assert('a Developer may act on a peer Developer', () =>
    codeOf(() => assertMayActOn(DEV, { adminId: DEV_B.adminId, tier: 1 }, 'suspend')) === null);

t.assert('...and it requires dual control', () =>
    assertMayActOn(DEV, { adminId: DEV_B.adminId, tier: 1 }, 'suspend').dualControlRequired);

t.assert('reinstating a peer Developer also requires dual control', () =>
    assertMayActOn(DEV, { adminId: DEV_B.adminId, tier: 1 }, 'reinstate').dualControlRequired);

t.assert('acting on a lower tier does NOT require dual control', () =>
    !assertMayActOn(ADMIN, { adminId: SUPPORT.adminId, tier: 3 }, 'suspend').dualControlRequired);

// ── Rule 4: never assign a level at or above your own ──
t.assert('an Admin cannot promote anyone to Admin', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: SUPPORT.adminId, tier: 3 }, 'set_tier', { newTier: 2 }))
    === ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN);

t.assert('an Admin cannot promote anyone to Developer', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: SUPPORT.adminId, tier: 3 }, 'set_tier', { newTier: 1 }))
    === ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN);

t.assert('an Admin CAN set someone to Support', () =>
    codeOf(() => assertMayActOn(ADMIN, { adminId: SUPPORT.adminId, tier: 3 }, 'set_tier', { newTier: 3 })) === null);

t.assert('a Developer CAN promote an Admin to Developer', () =>
    codeOf(() => assertMayActOn(DEV, { adminId: ADMIN.adminId, tier: 2 }, 'set_tier', { newTier: 1 })) === null);

t.assert('...and that requires dual control', () =>
    assertMayActOn(DEV, { adminId: ADMIN.adminId, tier: 2 }, 'set_tier', { newTier: 1 }).dualControlRequired);

t.assert('a Developer demoting an Admin to Support needs no approval', () =>
    !assertMayActOn(DEV, { adminId: ADMIN.adminId, tier: 2 }, 'set_tier', { newTier: 3 }).dualControlRequired);

t.assert('set_tier without newTier is a 500, not a silent pass', () => {
    try {
        assertMayActOn(DEV, { adminId: ADMIN.adminId, tier: 2 }, 'set_tier');
        return false;
    } catch (error) {
        return error instanceof AppError && error.statusCode === 500;
    }
});

// ── create ──
t.assert('an Admin can create a Support administrator', () =>
    codeOf(() => assertMayCreate(ADMIN, 3)) === null);

t.assert('an Admin cannot create a peer Admin', () =>
    codeOf(() => assertMayCreate(ADMIN, 2)) === ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN);

t.assert('an Admin cannot create a Developer', () =>
    codeOf(() => assertMayCreate(ADMIN, 1)) === ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN);

t.assert('a Developer can create an Admin', () => codeOf(() => assertMayCreate(DEV, 2)) === null);

t.assert('a Developer creating a Developer requires dual control', () =>
    assertMayCreate(DEV, 1).dualControlRequired);

t.assert('a Support administrator can create nobody', () =>
    codeOf(() => assertMayCreate(SUPPORT, 3)) === ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN);

// ── the non-throwing form agrees ──
t.assert('mayActOn mirrors assertMayActOn (allowed)', () =>
    mayActOn(ADMIN, { adminId: SUPPORT.adminId, tier: 3 }, 'suspend'));
t.assert('mayActOn mirrors assertMayActOn (refused)', () =>
    !mayActOn(ADMIN, { adminId: ADMIN_B.adminId, tier: 2 }, 'suspend'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Dual control');

t.assert('promoting to Developer needs approval', () =>
    dualControlRequired('administrators.tier.set', { adminId: 'x', tier: 1 }));

t.assert('promoting to Admin does not', () =>
    !dualControlRequired('administrators.tier.set', { adminId: 'x', tier: 2 }));

t.assert('demoting to Support does not', () =>
    !dualControlRequired('administrators.tier.set', { adminId: 'x', tier: 3 }));

t.assert('suspending a Developer needs approval', () =>
    dualControlRequired('administrators.suspend', { adminId: 'x', targetTier: 1, suspend: true }));

t.assert('suspending an Admin does not', () =>
    !dualControlRequired('administrators.suspend', { adminId: 'x', targetTier: 2, suspend: true }));

t.assert('a non-dual-controlled action never queues', () =>
    !dualControlRequired('cod.overview.read', {}));

t.assert('every dual-controlled permission describes itself', () =>
    PERMISSION_NAMES.every((name) => {
        const spec = permissionSpec(name).dualControl;
        if (!spec) return true;
        return spec.describe({ adminId: 'abc', tier: 1, targetTier: 1, suspend: true }).length > 0;
    }));

// ── idempotency key ──
t.assert('canonicalJson sorts keys', () =>
    canonicalJson({ b: 1, a: 2 }) === canonicalJson({ a: 2, b: 1 }));

t.assert('canonicalJson sorts nested keys', () =>
    canonicalJson({ x: { b: 1, a: 2 } }) === canonicalJson({ x: { a: 2, b: 1 } }));

t.assert('canonicalJson preserves array order — order is meaningful', () =>
    canonicalJson({ x: [1, 2] }) !== canonicalJson({ x: [2, 1] }));

t.assert('the same intent produces the same key', () =>
    approvalRequestKey('administrators.tier.set', 'administrator', 'abc', { tier: 1, adminId: 'abc' })
    === approvalRequestKey('administrators.tier.set', 'administrator', 'abc', { adminId: 'abc', tier: 1 }));

t.assert('a different level produces a different key', () =>
    approvalRequestKey('administrators.tier.set', 'administrator', 'abc', { tier: 1 })
    !== approvalRequestKey('administrators.tier.set', 'administrator', 'abc', { tier: 2 }));

t.assert('a different target produces a different key', () =>
    approvalRequestKey('administrators.tier.set', 'administrator', 'abc', { tier: 1 })
    !== approvalRequestKey('administrators.tier.set', 'administrator', 'xyz', { tier: 1 }));

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Resource scope');

t.assert('a Developer sees every ticket', () => resolveScope(identity('d', 1), 'tickets').kind === 'all');

/**
 * An Admin used to be `{ kind: 'all' }` here, beside the Developer. Phase 17 narrowed it,
 * and the narrowing is the policy rather than a tightening for its own sake: escalating a
 * ticket to a Developer has to mean something, and it means nothing if the person who
 * escalated it can still act on it afterwards.
 */
t.assert('an Admin no longer sees every ticket', () =>
    resolveScope(identity('a', 2), 'tickets').kind !== 'all');

t.assert('an Admin is scoped to their own, the pool, and Support’s', () => {
    const scope = resolveScope(identity('a1', 2), 'tickets');
    return scope.kind === 'assigned'
        && scope.adminIds.length === 1 && scope.adminIds[0] === 'a1'
        && scope.includeUnassigned
        && scope.alsoTiers.length === 1 && scope.alsoTiers[0] === 3;
});

t.assert('Support is scoped to its own tickets', () => {
    const scope = resolveScope(identity('s1', 3), 'tickets');
    return scope.kind === 'assigned' && scope.adminIds.length === 1 && scope.adminIds[0] === 's1';
});

t.assert('Support also sees the unassigned queue — otherwise nothing can be claimed', () => {
    const scope = resolveScope(identity('s1', 3), 'tickets');
    return scope.kind === 'assigned' && scope.includeUnassigned;
});

// The other half of the same rule: Support reaches no peer's work, only its own.
t.assert('Support reaches no other tier, not even a peer', () => {
    const scope = resolveScope(identity('s1', 3), 'tickets');
    return scope.kind === 'assigned' && scope.alsoTiers.length === 0;
});

const held = (adminId: string, tier: AdminTier) => ({ adminId, tier });
const SUPPORT_SCOPE = { kind: 'assigned', adminIds: ['me'], includeUnassigned: true, alsoTiers: [] } as const;
const ADMIN_SCOPE = { kind: 'assigned', adminIds: ['me'], includeUnassigned: true, alsoTiers: [3] } as const;

t.assert('isTicketInScope(all) admits anything', () =>
    isTicketInScope({ kind: 'all' }, held('someone-else', 1)) && isTicketInScope({ kind: 'all' }, null));

t.assert('isTicketInScope(none) admits nothing', () =>
    !isTicketInScope({ kind: 'none' }, held('me', 3)) && !isTicketInScope({ kind: 'none' }, null));

t.assert('isTicketInScope(assigned) admits your own', () =>
    isTicketInScope(SUPPORT_SCOPE, held('me', 3)));

t.assert('isTicketInScope(assigned) refuses someone else’s', () =>
    !isTicketInScope(SUPPORT_SCOPE, held('them', 3)));

t.assert('isTicketInScope(assigned) admits unassigned when configured', () =>
    isTicketInScope(SUPPORT_SCOPE, null));

t.assert('...and refuses it when not', () =>
    !isTicketInScope({ kind: 'assigned', adminIds: ['me'], includeUnassigned: false, alsoTiers: [] }, null));

// `alsoTiers` — the supervision rule, in its single-record form.
t.assert('an Admin scope admits a ticket a Support administrator holds', () =>
    isTicketInScope(ADMIN_SCOPE, held('someone-in-support', 3)));

t.assert('an Admin scope refuses a ticket a Developer holds', () =>
    !isTicketInScope(ADMIN_SCOPE, held('a-developer', 1)));

t.assert('an Admin scope refuses another Admin’s ticket', () =>
    !isTicketInScope(ADMIN_SCOPE, held('another-admin', 2)));

t.assert('a Support scope refuses a ticket a Support PEER holds', () =>
    !isTicketInScope(SUPPORT_SCOPE, held('a-peer', 3)));

t.assert('every scoped permission names a resolvable resource', () =>
    PERMISSION_NAMES.every((name) => {
        const scope = permissionSpec(name).scope;
        return scope === undefined || resolveScope(identity('s', 3), scope).kind !== undefined;
    }));

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Denial recording');

t.assert('a denial reaches the sink with every field', () => {
    const captured: AuthorizationDenial[] = [];
    setDenialSink((denial) => captured.push(denial));

    recordAuthorizationDenial({
        kind: 'permission',
        adminId: 'a1',
        tier: 3,
        sessionId: 's1',
        required: ['cod.remittances.confirm'],
        reason: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
        method: 'POST',
        path: '/api/v1/cod/remittances/x/confirm',
        requestId: 'req-1',
        ip: '10.0.0.1',
        userAgent: 'Mozilla/5.0',
    });

    resetDenialSink();

    return captured.length === 1
        && captured[0].adminId === 'a1'
        && captured[0].tier === 3
        && captured[0].requestId === 'req-1'
        && captured[0].required[0] === 'cod.remittances.confirm'
        // Phase 12: the field existed nowhere, so every denial row said null.
        && captured[0].userAgent === 'Mozilla/5.0';
});

t.assert('a throwing sink never turns a 403 into a 500', () => {
    setDenialSink(() => { throw new RangeError('sink exploded'); });
    const survived = !throws(() =>
        recordAuthorizationDenial({
            kind: 'permission', adminId: 'a', tier: 3, sessionId: 's', required: [],
            reason: 'x', method: 'GET', path: '/', requestId: 'r', ip: null, userAgent: null,
        }));
    resetDenialSink();
    return survived;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. Route manifest');

t.assert('the public allowlist holds exactly the three credential routes', () =>
    PUBLIC_ROUTE_ALLOWLIST.size === 3
    && PUBLIC_ROUTE_ALLOWLIST.has('POST /api/v1/auth/login')
    && PUBLIC_ROUTE_ALLOWLIST.has('POST /api/v1/auth/mfa/verify')
    && PUBLIC_ROUTE_ALLOWLIST.has('POST /api/v1/auth/refresh'));

/** Every `*.routes.ts` under src/, found without importing anything. */
function routeFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            routeFiles(full, found);
        } else if (entry.endsWith('.routes.ts')) {
            found.push(full);
        }
    }
    return found;
}

const SRC = join(__dirname, '..', '..', 'src');

/**
 * `/health` is outside `/api/v1` and outside this rule.
 *
 * It is mounted before the rate limiter precisely so an orchestrator can always reach it,
 * it takes no identity, and it exposes nothing that needs a decision. Declaring it public
 * through `defineRoute` would mean adding three entries to `PUBLIC_ROUTE_ALLOWLIST` that
 * say nothing.
 */
const SCAN_EXEMPT = ['api\\routes\\health.routes.ts', 'api/routes/health.routes.ts'];

/**
 * Strip comments before scanning.
 *
 * Several route files QUOTE the anti-pattern in their header — `auth.routes.ts` explains
 * why there is no router-wide `router.use(requireAdmin)` — and a naive scan reads the
 * explanation as the offence.
 */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const RAW_ROUTE_CALL = /\brouter\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(/;

const SCANNED = routeFiles(SRC).filter((file) => !SCAN_EXEMPT.some((exempt) => file.endsWith(exempt)));

t.assert('at least four route files are scanned — the scan is looking at something', () =>
    SCANNED.length >= 4);

// The backstop that needs no Express internals: if this passes, every route on the
// versioned surface went through `defineRoute` and therefore declared who may call it.
t.assert('no route file registers a route directly on the router', () => {
    const offenders = SCANNED.filter((file) => RAW_ROUTE_CALL.test(stripComments(readFileSync(file, 'utf8'))));
    if (offenders.length > 0) {
        console.error(`      offenders: ${offenders.map((f) => f.replace(SRC, 'src')).join(', ')}`);
    }
    return offenders.length === 0;
});

t.assert('every scanned route file calls defineRoute', () =>
    SCANNED.every((file) => readFileSync(file, 'utf8').includes('defineRoute(')));

/**
 * ── The audit half of the same three layers (Phase 12) ───────────────────────
 *
 * The type makes `audit` required on a mutating route and `assertAuditCoverageComplete()`
 * checks the declaration at boot. This is the third layer, and the only one that does not
 * depend on the code compiling the way we expect: a straight count over the source.
 *
 * It exists because the first two can be defeated the same way authorization's could —
 * by not using the helper. A file that reached for `router.post(` directly is already
 * caught above; this catches the subtler version where `defineRoute` is used but the
 * declaration count has drifted from the route count.
 */
const MUTATING_DECL = /method: '(post|put|patch|delete)'/g;
const AUDIT_DECL = /\baudit: /g;

function countOf(source: string, pattern: RegExp): number {
    return (source.match(pattern) ?? []).length;
}

t.assert('every mutating route in every route file carries an audit declaration', () => {
    const offenders: string[] = [];

    for (const file of SCANNED) {
        const code = stripComments(readFileSync(file, 'utf8'));
        const mutating = countOf(code, MUTATING_DECL);
        const declared = countOf(code, AUDIT_DECL);
        // `>=` not `===`: a GET may also declare one. `money.routes.ts` does — revealing a
        // beneficiary's account number is an action even though nothing changed.
        if (declared < mutating) {
            offenders.push(`${file.replace(SRC, 'src')} (${mutating} mutating, ${declared} declared)`);
        }
    }

    if (offenders.length > 0) console.error(`      offenders: ${offenders.join(', ')}`);
    return offenders.length === 0;
});

t.assert('every route file with an audit declaration imports the helper that builds one', () =>
    SCANNED.every((file) => {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (!AUDIT_DECL.test(code)) return true;
        return /\b(records|mayRecord|dynamicAudit|noAudit)\b/.test(code);
    }));

/**
 * `noAudit()` is the escape hatch, and it must stay unused.
 *
 * `NO_AUDIT_ROUTE_ALLOWLIST` is empty — every one of the 61 mutating routes maps to a real
 * action — so any appearance of `noAudit(` in a route file means somebody reached for the
 * hatch without doing the second half (the allowlist entry), and the boot assertion would
 * refuse to start. Failing here says so in a suite rather than at deploy time.
 */
t.assert('no route declares noAudit while the allowlist is empty', () => {
    if (NO_AUDIT_ROUTE_ALLOWLIST.size > 0) return true;
    return SCANNED.every((file) => !stripComments(readFileSync(file, 'utf8')).includes('noAudit('));
});

/**
 * ── The fourth layer: a mutating handler must REACH its tier scope (G-1) ─────
 *
 * `defineRoute` proves a route declared a PERMISSION. It cannot prove the handler behind it
 * applied the per-record SCOPE, and on the support surface those are different questions:
 * `support.tickets.attachments.write` says you may delete attachments, and the tier scope
 * says whose. `deleteAttachment` held the first and not the second, so any holder of that
 * one permission could delete any attachment on any ticket — including one belonging to a
 * tier they cannot see.
 *
 * This is keyed on the two FILES rather than on a list of handler names, which is the whole
 * point: the write set is derived from the route declarations, so a mutating route added
 * next year is covered without anybody remembering to extend a list here. That is what
 * would have caught the original.
 *
 * ⚠ It scans source rather than calling anything, so it proves the call is PRESENT, not that
 * it runs on every branch. `verify:authz` is where the behaviour is exercised end to end.
 */
const TICKET_ROUTES = join(SRC, 'modules', 'support', 'routes', 'ticket.routes.ts');
const TICKET_CONTROLLER = join(SRC, 'modules', 'support', 'controllers', 'ticket.controller.ts');

/**
 * `create` is the one exemption and it is structural, not an oversight: `POST /` makes a
 * ticket that does not exist yet, so there is no record for a scope to be applied to. Every
 * other mutating handler addresses an existing one.
 */
const SCOPE_EXEMPT_HANDLERS = new Set(['create']);

/** Handler names behind a mutating route, read out of the route declarations. */
function mutatingHandlerNames(routeSource: string): string[] {
    const names: string[] = [];
    // Each `defineRoute({...})` block is delimited by the closing `});` of the call.
    for (const block of stripComments(routeSource).split('defineRoute(').slice(1)) {
        const body = block.split('});')[0];
        if (!/method: '(post|put|patch|delete)'/.test(body)) continue;
        const handler = /handler:\s*SupportTicketController\.(\w+)/.exec(body);
        if (handler) names.push(handler[1]);
    }
    return names;
}

/** One handler's body, from `static <name> = asyncHandler(` to the closing `});`. */
function handlerBody(controllerSource: string, name: string): string | null {
    const marker = `static ${name} = asyncHandler(`;
    const at = controllerSource.indexOf(marker);
    if (at === -1) return null;
    const rest = controllerSource.slice(at);
    const end = rest.indexOf('\n    });');
    return end === -1 ? rest : rest.slice(0, end);
}

t.assert('the support route file yields a non-trivial set of mutating handlers', () =>
    mutatingHandlerNames(readFileSync(TICKET_ROUTES, 'utf8')).length >= 10);

t.assert('every mutating support handler reaches loadScoped — including the attachment delete', () => {
    const routes = readFileSync(TICKET_ROUTES, 'utf8');
    const controller = stripComments(readFileSync(TICKET_CONTROLLER, 'utf8'));
    const offenders: string[] = [];

    for (const name of mutatingHandlerNames(routes)) {
        if (SCOPE_EXEMPT_HANDLERS.has(name)) continue;
        const body = handlerBody(controller, name);
        if (body === null) {
            offenders.push(`${name} (no such handler)`);
        } else if (!body.includes('loadScoped(')) {
            offenders.push(`${name} (never reaches loadScoped)`);
        }
    }

    if (offenders.length > 0) console.error(`      offenders: ${offenders.join(', ')}`);
    return offenders.length === 0;
});

/**
 * The delete is keyed on the attachment, so reaching the scope needs a lookup first. Assert
 * the lookup specifically: a future "simplification" that drops it would leave `loadScoped`
 * in the file and satisfy the check above while reopening the hole.
 */
t.assert('deleteAttachment resolves the attachment to its ticket before scoping it', () => {
    const body = handlerBody(stripComments(readFileSync(TICKET_CONTROLLER, 'utf8')), 'deleteAttachment');
    return body !== null
        && body.includes('findTicketIdByAttachment(')
        && body.indexOf('findTicketIdByAttachment(') < body.indexOf('loadScoped(')
        && body.includes('assertMayAct(');
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('9. The legacy surface is GONE (Phase 5 Part D)');

/**
 * ── This section used to assert the checklist's CONTENTS; it now asserts its ABSENCE ──
 *
 * `legacy-endpoint-map.ts` listed every admin endpoint jovi-mall still served, mapped to the
 * permission that would guard it here. Phase 5 ported the last of them and Part D deleted the
 * map, the `legacy-audit` module that fed on the surface, the `audit.legacy_feed` flag and the
 * `AUDIT_LEGACY_FEED_DISABLED` code.
 *
 * Eight assertions lived here. Six of them ("no ticket row survives", "no COD row survives",
 * "every mapped permission exists", "no row is listed twice", "every mapped permission is
 * granted", "no row maps to a null permission") had the map itself as their subject, and with
 * the map gone they would each be a check that passes because there is nothing to check —
 * green forever, catching nothing. They are RESTATED here as the one fact that replaced all
 * six and is strictly stronger: **the map does not exist, and nothing imports it.** A row
 * cannot survive in a file that is not there.
 *
 * That is the `PHASE-17-STATUS.md` § 7 rule applied in the direction it is hardest to apply —
 * an assertion that goes green for the success is as dead as one that goes red for it.
 */

const LEGACY_MAP = join(SRC, 'modules', 'authorization', 'domain', 'legacy-endpoint-map.ts');

t.assert('the legacy endpoint map is deleted', () => !existsSync(LEGACY_MAP));

/**
 * ── The cutover tripwire, now unconditional ──────────────────────────────────
 *
 * It used to read `LEGACY_ENDPOINT_COUNT > 0 || !existsSync(…)` — "delete the module once the
 * surface is gone". The surface IS gone, the module IS deleted, and the escape hatch that made
 * the assertion conditional is exactly what must not come back: re-adding a row to a
 * resurrected map would silence it again. Pinned flat.
 *
 * `legacy-audit` served `GET /api/v1/audit/legacy`, a read of jovi-mall's `admin_action_log`
 * from this service. The COLLECTION survives cutover and its historical rows stay in Mongo —
 * `AuditLogger` still routes `role: 'admin'` entries there and `AdminAgencyService` reaches it
 * over the internal mount (Phase 5 C-10, D-7). What was deleted is this service's read of it,
 * because after cutover every new row duplicates a wi-admin audit row for the same operation
 * (D-8).
 */
t.assert('the legacy-audit module is deleted', () =>
    !existsSync(join(SRC, 'modules', 'legacy-audit')));

/**
 * The deletion has to be complete, not merely unmounted. A surviving import of either symbol
 * would not compile — but a surviving *file* under `src/` that reconstructs the checklist
 * would, and would read as live policy. Scan for the names rather than trusting `tsc`.
 */
t.assert('nothing under src/ references the legacy map or its constants', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) { walk(full); continue; }
            if (!entry.endsWith('.ts')) continue;
            const code = stripComments(readFileSync(full, 'utf8'));
            if (/LEGACY_ENDPOINT_(COUNT|MAP)|legacy-endpoint-map|legacy-audit/.test(code)) {
                offenders.push(full.replace(SRC, 'src'));
            }
        }
    };
    walk(SRC);
    if (offenders.length > 0) console.error(`      offenders: ${offenders.join(', ')}`);
    return offenders.length === 0;
});

/**
 * The feature flag and the error code went with the module, and both would otherwise be dead
 * config that reads as live policy — `feature-flag.catalog.ts`'s own header refuses to carry a
 * flag whose consumer file does not exist, and a catalogued error code no route can raise is a
 * promise to a client that nothing keeps.
 */
t.assert('`audit.legacy_feed` is gone from the feature-flag catalog', () =>
    !Object.keys(FEATURE_FLAG_CATALOG).includes('audit.legacy_feed'));

t.assert('`AUDIT_LEGACY_FEED_DISABLED` is gone from the error registry', () =>
    !Object.keys(ERROR_CODES).includes('AUDIT_LEGACY_FEED_DISABLED'));

/**
 * ── The `customers` family is gone too (ADR-017 D-1, Part D step D.1) ────────
 *
 * `customers.read` and `customers.suspend` were the only pair on the unbuilt list that was
 * GRANTED while backing no route — tier 2 by `allInFamily('customers')`, tier 3 `customers.read`
 * by name. A granted permission with no endpoint shows up in an administrator's effective set
 * and in the dashboard's permission screen, promising a surface that does not exist.
 *
 * Asserted here rather than trusted, because re-adding either name is a one-line edit and both
 * halves matter: the names, and the family that would let `allInFamily` sweep them back in.
 */
t.assert('neither customers.* permission is catalogued', () =>
    !PERMISSION_NAMES.includes('customers.read' as PermissionName)
    && !PERMISSION_NAMES.includes('customers.suspend' as PermissionName));

t.assert('`customers` is gone from PERMISSION_FAMILIES', () =>
    !(PERMISSION_FAMILIES as readonly string[]).includes('customers'));

t.assert('no tier grants anything under `customers.`', () =>
    ([1, 2, 3] as const).every((tier) =>
        !TIER_GRANTS[tier].some((name) => String(name).startsWith('customers.'))));
// ─────────────────────────────────────────────────────────────────────────────
t.section('10. Error codes');

const NEW_CODES = [
    'AUTHZ_PERMISSION_DENIED',
    'AUTHZ_TIER_INSUFFICIENT',
    'AUTHZ_SELF_ACTION_FORBIDDEN',
    'AUTHZ_TARGET_TIER_PROTECTED',
    'AUTHZ_TIER_ESCALATION_FORBIDDEN',
    'AUTHZ_APPROVAL_REQUIRED',
    'AUTHZ_APPROVAL_NOT_FOUND',
    'AUTHZ_APPROVAL_SELF_APPROVAL',
    'AUTHZ_APPROVAL_EXPIRED',
    'AUTHZ_APPROVAL_ALREADY_RESOLVED',
    'AUTHZ_ROUTE_UNDECLARED',
    'AUTHZ_GRANT_TABLE_INVALID',
    'ADMIN_ACCOUNT_ALREADY_EXISTS',
] as const;

for (const code of NEW_CODES) {
    t.assert(`${code} is registered`, () => (ERROR_CODES as Record<string, string>)[code] === code);
}

t.assert('every new code has a default message', () =>
    NEW_CODES.every((code) => {
        const error = createAppError(ERROR_CODES[code], 403);
        return error.message.length > 0 && error.message !== 'An error occurred';
    }));

t.assert('a 403 is operational; a 500 is not', () =>
    createAppError(ERROR_CODES.AUTHZ_PERMISSION_DENIED, 403).isOperational
    && !createAppError(ERROR_CODES.AUTHZ_GRANT_TABLE_INVALID, 500).isOperational);

t.assert('the escalation messages never name the caller’s own level', () =>
    [
        ERROR_CODES.AUTHZ_SELF_ACTION_FORBIDDEN,
        ERROR_CODES.AUTHZ_TARGET_TIER_PROTECTED,
        ERROR_CODES.AUTHZ_TIER_ESCALATION_FORBIDDEN,
    ].every((code) => !/tier [123]|Developer|Admin\b|Support/.test(createAppError(code, 403).message)));

// ─────────────────────────────────────────────────────────────────────────────
t.section('11. Catalog/grant consistency under mutation');

t.assert('PERMISSION_CATALOG is a frozen shape — names cannot be added at runtime', () => {
    const before = PERMISSION_NAMES.length;
    try {
        (PERMISSION_CATALOG as unknown as Record<string, unknown>)['injected.permission'] = {};
    } catch {
        // strict mode may throw instead — either outcome is fine
    }
    return PERMISSION_NAMES.length === before && !isPermissionName('injected.permission');
});

t.assert('TIER_GRANTS is frozen', () => Object.isFrozen(TIER_GRANTS));

process.exit(t.finish());

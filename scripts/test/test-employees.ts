/**
 * The administrator employee record and the pending-activation gate (ADR-023) — offline.
 *
 * Everything here is a pure function of code: the status enum, the route manifest, the
 * permission catalog, the grant table, the validators, the readiness gate and the DTO. No
 * Mongo, no Redis, no jovi-mall.
 *
 * Six sections carry the weight, and each pins a decision nothing else can:
 *
 *   §2  the onboarding allowlist. It is the entire blast radius of the `pending` state, and
 *       the assertion that an entry must be `selfService` is what stops somebody listing
 *       `POST /approvals/:id/approve` — a route that IS declared `selfService` and is the
 *       most consequential act on this service.
 *   §3  the tier boundary. Tier 2 holds `allInFamily('administrators')`, so the ONLY thing
 *       keeping a colleague's salary away from an Admin is that `employees` is a separate
 *       family. Asserted from both ends.
 *   §4  the audit payloads. Every employee-record row names the KEYS that changed and never
 *       their values, because `audit.read` reaches tier 3. A `before`/`after` carrying a
 *       salary would route this record into the one feed it is withheld from.
 *   §5  the private tree. The upload gateway must target `/identity-documents`, never
 *       `/files/upload` — the two differ in one string and that string is the whole privacy
 *       mechanism, because `by-type` lands in six PUBLIC trees.
 *   §6  the readiness gate. The owner chose a backend-enforced required set, DIVERGING from
 *       the applicant KYC module's "grade nothing" decision taken the same week. A
 *       divergence nothing asserts is indistinguishable from an inconsistency.
 *
 *   npm run test:employees
 */
import { suite } from './_assert';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ONBOARDING_ROUTE_ALLOWLIST, routeManifest } from '../../src/api/route-manifest';
import { ADMIN_STATUSES } from '../../src/modules/admin-identity/domain/admin-identity.types';
import {
    PERMISSION_NAMES,
    permissionSpec,
} from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS, allInFamily } from '../../src/modules/authorization/domain/tier-grants';
import { AUDIT_CATALOG } from '../../src/modules/audit/domain/audit.catalog';
import { NON_ROUTE_AUDIT_PRODUCERS } from '../../src/modules/audit/domain/audit.producers';
import {
    ACTIVATION_REQUIRED_SLOTS,
    EMPLOYEE_DOCUMENT_SLOTS,
    EMPLOYEE_DOCUMENT_SLOT_NAMES,
    employeeSlotField,
} from '../../src/modules/employees/domain/employee-document.types';
import { assessReadiness } from '../../src/modules/employees/domain/employee-readiness';
import { toEmployeeRecordDto } from '../../src/modules/employees/read-models/employee-record.dto';
import {
    ENABLED_PAYOUT_METHODS,
    maskPayoutMethods,
} from '../../src/modules/employees/domain/employee-payout.types';
import {
    UpdateEmployeeRecordSchema,
    UpdateEmploymentSchema,
} from '../../src/modules/employees/validators/employee.validator';
import { STORAGE_TREE_VISIBILITY } from '../../src/infra/storage/storage-trees';
import { ERROR_CODES } from '../../src/core/errors/error-codes';

// Importing the routers is what registers them on the manifest.
import '../../src/modules/employees/routes/employee.routes';
import '../../src/modules/geo/routes/geo.routes';
import '../../src/modules/administrators/routes/administrator.routes';
import '../../src/modules/admin-identity/routes/auth.routes';
import '../../src/modules/authorization/routes/permissions.routes';
import '../../src/modules/dual-control/routes/approval.routes';

const t = suite('administrator employee records');

const SRC = join(__dirname, '..', '..', 'src');

/** Comments stripped, so a doc comment explaining a rule cannot be read as breaking it. */
function code(...segments: string[]): string {
    return readFileSync(join(SRC, ...segments), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

const manifest = routeManifest();
const routeAt = (key: string) =>
    manifest.find((r) => `${r.method.toUpperCase()} ${r.fullPath}` === key);

/** Every `.ts` file under `src/`, walked — a scan whose coverage nobody has to maintain. */
function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });
}

const srcFiles = walk(SRC);

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The pending state');

t.assert('there are exactly three account statuses', () => ADMIN_STATUSES.length === 3);

t.assert('`pending` is one of them', () => ADMIN_STATUSES.includes('pending'));

/**
 * The default is the enforcement. A new administrator is an unverified person until a
 * Developer has read their employee record, and the cheapest way to guarantee that is for
 * the schema to refuse to produce an active account by omission.
 */
t.assert('the model defaults status to pending, not active', () => {
    const model = code('modules', 'admin-identity', 'models', 'admin-account.model.ts');
    return /enum: ADMIN_STATUSES, default: 'pending'/.test(model);
});

/**
 * The bootstrap CLI is the one SHIPPING caller allowed to create an active account, because
 * there is nobody to activate the first administrator and a `pending` one would leave the
 * service with no reachable administrator at all.
 *
 * ⚠ **Scoped to `src/**` and the bootstrap script, deliberately — the live-verify fixtures also
 * pass `status: 'active'` and are not offenders.** They seed administrators directly through the
 * repository to exercise permissioned routes, and a pending fixture is refused every route the
 * suite is about. Widening this scan to `scripts/` would make it red for thirteen files that are
 * correct, which is how a guard gets deleted.
 *
 * What it actually asserts: the bootstrap does it, and **no service under `src/` does**. That is
 * the boundary that matters — a runtime path minting an active administrator is the one that
 * would skip the gate for a real person.
 */
t.assert('the bootstrap CLI passes status: active, and no src/ service does', () => {
    const bootstrap = readFileSync(join(SRC, '..', 'scripts', 'bootstrap-admin.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    if (!/status:\s*'active'/.test(bootstrap)) return false;

    // Every service and gateway under src/, walked — not a hand-listed file, so a new one is
    // covered without anybody remembering to add it here.
    const offenders = srcFiles.filter((file) => /\.(service|gateway|controller)\.ts$/.test(file))
        .filter((file) => /status:\s*'active'/.test(
            readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
        ));

    if (offenders.length > 0) console.error(`      offenders: ${offenders.join(', ')}`);
    return offenders.length === 0;
});

/**
 * ⚠ The escalation this closes: reinstatement used to write `'active'` unconditionally, which
 * was correct while `active` and `suspended` were the only states. Adding `pending` turned it
 * into a way to activate somebody past the tier-1 gate, with an audit trail saying
 * "reinstated" — which is what was asked for, and not what happened.
 */
t.assert('reinstatement restores the prior status rather than hardcoding active', () => {
    const repo = code('modules', 'admin-identity', 'repositories', 'admin-account.repository.ts');
    return repo.includes('suspendedFromStatus')
        && /suspended_from_status: suspendedFromStatus/.test(repo);
});

t.assert('...and the suspend call site passes the account’s current status', () => {
    const service = code('modules', 'administrators', 'domain', 'administrator.service.ts');
    return /setSuspension\(adminId, \{ by, reason \}, session, current\.status\)/.test(service);
});

t.assert('...and the reinstate call site passes what was stored', () => {
    const service = code('modules', 'administrators', 'domain', 'administrator.service.ts');
    return /current\.suspended_from_status \?\? 'active'/.test(service);
});

/**
 * A pending administrator keeps their session; a suspended one does not. The two branches
 * look alike and must not behave alike — evicting a new administrator's session on every
 * request would sign them out while filling in the only form they are here to fill in.
 */
t.assert('the pending gate does not destroy sessions', () => {
    const mw = code('api', 'middlewares', 'authenticate.middleware.ts');
    const branch = mw.slice(mw.indexOf("admin.status === 'pending'"));
    const body = branch.slice(0, branch.indexOf('\n    const pendingMfaEnrolment'));
    return body.includes('ADMIN_ACTIVATION_REQUIRED') && !body.includes('destroyAllSessions');
});

t.assert('...and answers its own code, not the suspended one', () =>
    ERROR_CODES.ADMIN_ACTIVATION_REQUIRED === 'ADMIN_ACTIVATION_REQUIRED');

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The onboarding allowlist — the blast radius of `pending`');

t.assert('the allowlist is not empty', () => ONBOARDING_ROUTE_ALLOWLIST.size > 0);

t.assert('every entry names a route that actually exists', () =>
    [...ONBOARDING_ROUTE_ALLOWLIST].every((key) => routeAt(key) !== undefined));

/**
 * ⚠ **THE assertion in this file.**
 *
 * The obvious design — "a pending administrator may reach any `selfService` route" — is one
 * line instead of a list, and it is WRONG. Three routes carry `selfService` because their
 * permission is resolved PER REQUEST against a queued action: `POST /approvals/:id/approve`,
 * `/reject` and `/withdraw`. Approving is the most consequential act on this service, and a
 * kind-based rule would hand it to somebody nobody has admitted yet.
 *
 * So the list is explicit, and this asserts nothing escapes it.
 */
t.assert('no approval route is reachable before activation', () =>
    ![...ONBOARDING_ROUTE_ALLOWLIST].some((key) => key.includes('/approvals/')));

t.assert('every entry is a selfService route — never a permission route', () =>
    [...ONBOARDING_ROUTE_ALLOWLIST].every((key) => routeAt(key)!.access.kind === 'self'));

/**
 * The gate is selected from the allowlist rather than declared per route, so a route added
 * next year is closed to a pending administrator without its author knowing the state exists.
 */
t.assert('gateFor consults the allowlist, and only for `self`', () => {
    const manifestSrc = code('api', 'route-manifest.ts');
    return /access\.kind === 'self' && ONBOARDING_ROUTE_ALLOWLIST\.has\(routeKey\)/.test(manifestSrc);
});

/**
 * The four `mfaEnrolment()` routes are reachable by a pending administrator through the OTHER
 * gate and are deliberately NOT in this list — see its header. Asserted so the omission stays
 * a decision rather than becoming a gap somebody "fixes" by adding them (which the boot
 * assertion would then refuse).
 */
t.assert('the MFA enrolment routes are reachable but not listed', () => {
    const enrolment = manifest
        .filter((r) => r.access.kind === 'mfa-enrolment')
        .map((r) => `${r.method.toUpperCase()} ${r.fullPath}`);
    if (enrolment.length === 0) return false;
    return enrolment.every((key) => !ONBOARDING_ROUTE_ALLOWLIST.has(key));
});

t.assert('...and that gate lifts BOTH half-states', () => {
    const mw = code('api', 'middlewares', 'authenticate.middleware.ts');
    const decl = mw.slice(mw.indexOf('export const requireAdminAllowingMfaEnrolment'));
    const body = decl.slice(0, decl.indexOf('});'));
    return /allowPendingMfaEnrolment: true/.test(body) && /allowPendingActivation: true/.test(body);
});

/** A new administrator cannot finish their record without geocoding a home address. */
t.assert('address search is reachable before activation', () =>
    ONBOARDING_ROUTE_ALLOWLIST.has('GET /api/v1/geo/search'));

t.assert('the whole employee-record surface is reachable before activation', () => {
    const own = manifest
        .filter((r) => r.fullPath.startsWith('/api/v1/employees/me'))
        .map((r) => `${r.method.toUpperCase()} ${r.fullPath}`);
    if (own.length < 5) return false;
    return own.every((key) => ONBOARDING_ROUTE_ALLOWLIST.has(key));
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The tier boundary — tier 1 and the subject, nobody else');

t.assert('the employees family holds exactly two permissions', () =>
    PERMISSION_NAMES.filter((n) => permissionSpec(n).family === 'employees').length === 2);

t.assert('tier 1 holds both', () => {
    const names = PERMISSION_NAMES.filter((n) => permissionSpec(n).family === 'employees');
    return names.every((n) => TIER_GRANTS[1].includes(n));
});

/**
 * ⚠ The whole point of the separate family. Tier 2 holds `allInFamily('administrators')`, so a
 * permission living there is a permission an Admin holds — and reading a colleague's salary,
 * date of birth and home address is not something an Admin may do.
 */
t.assert('neither tier 2 nor tier 3 holds anything in the employees family', () => {
    const names = PERMISSION_NAMES.filter((n) => permissionSpec(n).family === 'employees');
    return names.every((n) => !TIER_GRANTS[2].includes(n) && !TIER_GRANTS[3].includes(n));
});

/**
 * The other end of the same rule. `employees.read` carries no `escalation`, `financial` or
 * `destructive` flag — it is an ordinary read, and flagging it otherwise would misdescribe it
 * in the catalog administrators actually read. So `allInFamily('employees')` WOULD expand it,
 * and one line added to the tier-2 list would hand every Admin the lot.
 *
 * The boot assertion is what stops that, and this is what proves the boot assertion is needed.
 */
t.assert('allInFamily(employees) DOES expand employees.read — the flag is not the guard', () =>
    allInFamily('employees').includes('employees.read'));

t.assert('...so the grant table assertion refuses the family below tier 1', () => {
    const grants = code('modules', 'authorization', 'domain', 'tier-grants.ts');
    return /spec\.family === 'employees' && tier !== 1/.test(grants);
});

/** Setting what a person is paid is financial by the flag's own definition. */
t.assert('employees.employment.write is flagged financial', () =>
    permissionSpec('employees.employment.write').financial === true);

t.assert('administrators.activate is flagged escalation', () =>
    permissionSpec('administrators.activate').escalation === true);

/**
 * ⚠ **There is no listing route, at any tier, and the repository has no query to build one.**
 *
 * A listing would be the one way to ask "show me every salary". The permission does not stop
 * it — tier 1 legitimately holds `employees.read`. What stops it is that the query does not
 * exist, which is a structural bound a configuration mistake cannot widen.
 */
t.assert('there is no employees listing route', () =>
    !manifest.some((r) => `${r.method.toUpperCase()} ${r.fullPath}` === 'GET /api/v1/employees'));

t.assert('...and the repository exposes no list or find-many', () => {
    const repo = code('modules', 'employees', 'repositories', 'employee-record.repository.ts');
    return !/\bfind\(/.test(repo) && !/async list\b/.test(repo);
});

/** Departure is `employment.endedOn`; access is removed by suspending the account. */
t.assert('there is no employee-record delete route', () =>
    !manifest.some((r) => r.method === 'delete' && /^\/api\/v1\/employees\/[^/]+$/.test(r.fullPath)));

/**
 * The self-service writes take no id, so there is no authorization decision on them at all.
 * Adding an `adminId` parameter would be the single most consequential change anybody could
 * make to this module — a surface with no decision becomes one with a decision to get right,
 * on a payload that is a photograph of somebody holding their identity card.
 */
t.assert('every /me write route is selfService and carries no id', () => {
    const own = manifest.filter(
        (r) => r.fullPath.startsWith('/api/v1/employees/me') && r.method !== 'get',
    );
    if (own.length < 4) return false;
    return own.every((r) => r.access.kind === 'self' && !r.fullPath.includes(':adminId'));
});

/**
 * The one crossing: the company states its terms. Everything else about an employee is
 * written by the employee, and a Developer who could rewrite a colleague's date of birth or
 * payout destination would make the record evidence of nothing.
 */
t.assert('the ONLY id-taking write is the employment block', () => {
    const writes = manifest.filter(
        (r) => r.fullPath.startsWith('/api/v1/employees/') && r.method !== 'get' && r.fullPath.includes(':adminId'),
    );
    return writes.length === 1 && writes[0].fullPath === '/api/v1/employees/:adminId/employment';
});

t.assert('...and the self-service schema refuses an employment key', () => {
    const parsed = UpdateEmployeeRecordSchema.safeParse({
        fullName: 'A B',
        employment: { monthlySalaryMinor: 999_999 },
    });
    return !parsed.success;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The audit rows record KEYS, never VALUES');

/**
 * ⚠ `audit.read` reaches tier 3, narrowed per row. A `before`/`after` carrying a salary, a
 * date of birth or a mother's maiden name would route this record's contents into the one
 * feed it is specifically withheld from. That the ACTOR is tier 1 does not help — the ROW's
 * audience is not the actor's.
 */
t.assert('the service records a `fields` key list and no record values', () => {
    const service = code('modules', 'employees', 'domain', 'employee.service.ts');
    if (!/function changedKeys/.test(service)) return false;

    // The four record writes must all go through `changedKeys` or a slot/file id — never a
    // spread of the input.
    return !/payload: \{ \.\.\.input/.test(service)
        && !/after: input\b/.test(service)
        && !/before: \{ \.\.\./.test(service);
});

t.assert('the employment write in particular records only field names', () => {
    const service = code('modules', 'employees', 'domain', 'employee.service.ts');
    const fn = service.slice(service.indexOf('export async function updateEmployment'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    return /payload: \{ fields: changedKeys\(input\) \}/.test(body)
        && !/monthlySalaryMinor/.test(body.slice(body.indexOf('auditedTransaction')));
});

t.assert('all six employees.* audit actions are catalogued', () => {
    const actions = Object.keys(AUDIT_CATALOG).filter((a) => a.startsWith('employees.'));
    return actions.length === 6;
});

/**
 * The upload is emitted by the gateway as an ATTEMPT before the bytes move, and its transport
 * is `external` — the bytes land in jovi-mall's database, which no wi-admin ClientSession can
 * join. It therefore cannot be declared by the route, and needs a producer entry.
 */
t.assert('employees.documents.upload is external transport', () =>
    AUDIT_CATALOG['employees.documents.upload'].transport === 'external');

t.assert('...and is registered as a non-route producer', () =>
    Object.values(NON_ROUTE_AUDIT_PRODUCERS)
        .some((actions) => actions.includes('employees.documents.upload')));

/** An employee states their own facts; the company states its terms. */
t.assert('only the employment action is governed by a permission', () => {
    const employeeActions = Object.entries(AUDIT_CATALOG)
        .filter(([name]) => name.startsWith('employees.'));
    const governed = employeeActions.filter(([, spec]) => spec.permission !== null);
    return governed.length === 1 && governed[0][0] === 'employees.employment.update';
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. The private tree — where the identity documents actually go');

/**
 * ⚠ **THE assertion that keeps a national identity card off a public URL.**
 *
 * `POST /files/upload` passes `folder: 'by-type'`, which resolves to one of six trees, and
 * `storage-trees.ts` classifies ALL SIX as public. The staff gateway must target
 * `/identity-documents` instead. The two differ in one string, and that string is the entire
 * privacy mechanism — there is no `sensitive` flag on a file and no second gate.
 */
t.assert('the staff gateway targets /identity-documents, never /files/upload', () => {
    const gateway = code('modules', 'employees', 'gateways', 'employee-document.gateway.ts');
    return gateway.includes("path: '/identity-documents'")
        && !gateway.includes("'/files/upload'");
});

t.assert('the admin-identity tree is classified PRIVATE in this service’s copy', () =>
    STORAGE_TREE_VISIBILITY['admin-identity'] === 'private');

/**
 * The reason the copy above matters: `toFileDetail` reads it to decide whether a stored key
 * gets a real URL. The six `by-type` trees are public, which is what makes reusing the media
 * upload for this a disclosure rather than a shortcut.
 */
t.assert('...while every by-type tree is public — which is why reuse was refused', () =>
    ['images', 'videos', 'audio', 'documents', 'archives', 'other']
        .every((tree) => STORAGE_TREE_VISIBILITY[tree] === 'public'));

/** Payout destinations are masked for EVERYBODY, the subject and the reviewer alike. */
t.assert('payout destinations are masked on read', () => {
    const masked = maskPayoutMethods([
        {
            method: 'mobile_money',
            mobile_money: { provider: 'MTN', phone_number: '+237670001122', account_name: 'A B' },
            bank: null,
            card: null,
        },
    ]);
    return masked[0].mobileMoney!.phoneNumberMasked.endsWith('1122')
        && !masked[0].mobileMoney!.phoneNumberMasked.includes('237670');
});

t.assert('mobile money is the only payout kind open for new configuration', () =>
    ENABLED_PAYOUT_METHODS.length === 1 && ENABLED_PAYOUT_METHODS[0] === 'mobile_money');

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The readiness gate — a DELIBERATE divergence from applicant KYC');

/**
 * ⚠ jovi-mall's KYC module states, as an owner decision taken the same week, that **nothing
 * is required** and the dashboard grades. The owner chose the opposite here (ADR-023 D-5).
 *
 * The two are not inconsistent — an applicant is a member of the public who needs to be told
 * what is missing by a human, an employee is somebody the company is handing administrative
 * access to — but a divergence nothing asserts is indistinguishable from an inconsistency,
 * and the next person to notice it will "fix" it in the wrong direction.
 */
const ACCOUNT = {
    _id: { toString: () => '65f0000000000000000000aa' },
    tier: 1 as const,
    status: 'pending',
    mfa_enrolled: true,
    email: 'a@b.test',
} as never;

t.assert('an empty record is not ready', () => !assessReadiness(ACCOUNT, null).ready);

/**
 * ⚠ A MISSING record is graded exactly like an EMPTY one — eight gaps, not one.
 *
 * This caught a real bug: the first version pushed a single `record_missing` gap and guarded
 * every field check behind `if (record)`, so an administrator who had never opened the form
 * got a checklist with one line on it and could not see what they were being asked for until
 * they had already started. The DTO's docblock promised the opposite, which is what made the
 * contradiction visible.
 */
t.assert('...and a MISSING record is graded like an empty one — the full checklist', () =>
    assessReadiness(ACCOUNT, null).gaps.length === 9);

t.assert('every gap carries a stable code and a section', () =>
    assessReadiness(ACCOUNT, null).gaps.every(
        (g) => typeof g.code === 'string' && g.code.length > 0 && typeof g.section === 'string',
    ));

/** The three identity slots are required; the contract deliberately is not. */
t.assert('the required slots are the three identity ones', () =>
    ACTIVATION_REQUIRED_SLOTS.length === 3
    && ACTIVATION_REQUIRED_SLOTS.includes('id_card_front')
    && ACTIVATION_REQUIRED_SLOTS.includes('id_card_back')
    && ACTIVATION_REQUIRED_SLOTS.includes('selfie_with_id'));

/**
 * An employee frequently starts before the paperwork is countersigned, and a gate that blocks
 * activation on a document the COMPANY owes THEM would stop the wrong person.
 */
t.assert('the signed contract is NOT required for activation', () =>
    !ACTIVATION_REQUIRED_SLOTS.includes('signed_contract'));

const FULL_RECORD = {
    full_name: 'A B',
    date_of_birth: new Date('1990-01-01'),
    id_number: 'CM123456',
    home_address: { formatted_address: 'x', coordinates: { type: 'Point', coordinates: [0, 0] } },
    phones: [{ label: null, number: '+237670001122' }],
    payout_methods: [{ method: 'mobile_money', mobile_money: {}, bank: null, card: null }],
    id_card_front_file_id: 'a',
    id_card_back_file_id: 'b',
    selfie_with_id_file_id: 'c',
} as never;

t.assert('a complete record is ready', () => assessReadiness(ACCOUNT, FULL_RECORD).ready);

/**
 * ⚠ MFA is required only where the TIER requires it, reading `ADMIN_MFA_REQUIRED_TIER`.
 * Hardcoding "MFA always" would make this gate quietly override an existing configuration
 * knob, in a second place, where nobody looking at that knob would find it.
 */
t.assert('an unenrolled tier-1 account is not ready', () =>
    !assessReadiness({ ...(ACCOUNT as object), mfa_enrolled: false } as never, FULL_RECORD).ready);

t.assert('...and the gate reads mfaRequiredForTier rather than a literal', () => {
    const gate = code('modules', 'employees', 'domain', 'employee-readiness.ts');
    return gate.includes('mfaRequiredForTier(account.tier)');
});

/** The employee sees the same checklist the Developer does — computed once, not twice. */
t.assert('the DTO carries readiness for the subject too', () => {
    const dto = toEmployeeRecordDto(ACCOUNT, null);
    return dto.readiness !== undefined && dto.readiness.ready === false;
});

t.assert('...and the activation service re-checks INSIDE the transaction', () => {
    const activation = code('modules', 'administrators', 'domain', 'activation.service.ts');
    const inner = activation.slice(activation.indexOf('auditedTransaction'));
    return /assessReadiness\(fresh,/.test(inner);
});

/** Activation is never a back door around a suspension, which is dual-controlled. */
t.assert('activation refuses a suspended account', () => {
    const activation = code('modules', 'administrators', 'domain', 'activation.service.ts');
    return /target\.status === 'suspended'/.test(activation)
        && activation.includes('ADMIN_ACTIVATION_SUSPENDED');
});

t.assert('activation refuses the caller’s own account', () => {
    const activation = code('modules', 'administrators', 'domain', 'activation.service.ts');
    return /adminId === actor\.adminId/.test(activation)
        && activation.includes('ADMIN_ACTIVATION_SELF');
});

/** A compare-and-set, so two Developers clicking one button produce one activation. */
t.assert('the activate write is guarded by the current status', () => {
    const repo = code('modules', 'admin-identity', 'repositories', 'admin-account.repository.ts');
    const fn = repo.slice(repo.indexOf('async activate('));
    return /status: 'pending' as AdminStatus/.test(fn.slice(0, fn.indexOf('\n    }')));
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The document slots and the record shape');

t.assert('there are six slots', () => EMPLOYEE_DOCUMENT_SLOT_NAMES.length === 6);

t.assert('the house-exterior photo exists — it is what this set adds over applicant KYC', () =>
    EMPLOYEE_DOCUMENT_SLOT_NAMES.includes('home_exterior_photo'));

t.assert('the hand-drawn sketch is multi-valued', () =>
    EMPLOYEE_DOCUMENT_SLOTS.home_address_sketch === 'multi');

t.assert('the identity slots are single-valued — a second upload is a correction', () =>
    ACTIVATION_REQUIRED_SLOTS.every((slot) => EMPLOYEE_DOCUMENT_SLOTS[slot] === 'single'));

t.assert('the column name follows the cardinality', () =>
    employeeSlotField('id_card_front') === 'id_card_front_file_id'
    && employeeSlotField('home_address_sketch') === 'home_address_sketch_file_ids');

/** Every slot appears on every read, so "no document" and "no such slot" cannot be confused. */
t.assert('the DTO lists every slot even on an empty record', () =>
    toEmployeeRecordDto(ACCOUNT, null).documents.length === EMPLOYEE_DOCUMENT_SLOT_NAMES.length);

t.assert('...as ids, never as URLs', () => {
    const dto = code('modules', 'employees', 'read-models', 'employee-record.dto.ts');
    return !/\burl\b\s*:/.test(dto);
});

/**
 * A date of birth shifted by a timezone offset is a person who is a day older in one reading
 * than another — exactly the discrepancy that makes an identity document appear not to match.
 */
t.assert('a calendar date is refused when sent as an instant', () =>
    !UpdateEmployeeRecordSchema.safeParse({ dateOfBirth: '1990-01-01T00:00:00.000Z' }).success);

t.assert('...and accepted as YYYY-MM-DD', () =>
    UpdateEmployeeRecordSchema.safeParse({ dateOfBirth: '1990-01-01' }).success);

/**
 * A salary accepted as a float is a payroll figure that will not reconcile, and that is a
 * conversation with a person rather than a rounding error.
 */
t.assert('a fractional salary is refused', () =>
    !UpdateEmploymentSchema.safeParse({ monthlySalaryMinor: 450_000.5 }).success);

t.assert('an end date before the start date is refused', () =>
    !UpdateEmploymentSchema.safeParse({ startedOn: '2026-05-01', endedOn: '2026-01-01' }).success);

/** An empty PATCH almost always means the client sent the wrong shape. */
t.assert('an empty patch is refused rather than silently succeeding', () =>
    !UpdateEmployeeRecordSchema.safeParse({}).success);

/** A national contact number is a payout instruction nobody can execute. */
t.assert('a national phone number is refused', () =>
    !UpdateEmployeeRecordSchema.safeParse({ phones: [{ number: '670001122' }] }).success);

t.assert('strict schemas refuse an unknown key rather than dropping it', () =>
    !UpdateEmployeeRecordSchema.safeParse({ fullName: 'A B', nickname: 'C' }).success);

process.exit(t.finish());

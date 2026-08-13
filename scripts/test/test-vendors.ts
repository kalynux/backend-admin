/**
 * Vendor management — the rules, with no infrastructure.
 *
 * Everything here is a pure function of code: the query schemas, the Mongo filters the
 * two lists build, the catalog wiring, and the projections that decide what leaves the
 * database. No Mongo, no Redis, no jovi-mall process.
 *
 * Five sections carry their weight; the rest are guard rails:
 *
 *   §2  the vendor filter composes under `$and`. TWO clauses here are `$or`-shaped — the
 *       search and `kycStatus=pending` — so merging by assignment would drop one silently.
 *   §3  the product filter pins `deletedAt: null` for EVERY input. jovi-mall's
 *       `BaseRepository` applies it automatically and this service's raw-driver reads do
 *       not, so a soft-deleted listing would otherwise reach an oversight screen.
 *   §5  nothing sensitive leaves. `payout_details` and `kyc_details.national_id_number`
 *       must appear in no projection — and neither must the whole-subdocument form
 *       `kyc_details: 1`, which would drag the identity number along with the flag.
 *   §6  the suspension is ENFORCED in jovi-mall, and enforced NARROWLY. Without the first
 *       this phase ships a button that changes a column nobody reads; without the second
 *       it ships a mass lockout of every unverified vendor.
 *   §7  no `vendors.*` permission is sensitive — because `allInFamily()` filters sensitive
 *       entries out, so flagging one would silently drop it from tier 2's grant and no
 *       boot assertion would catch it.
 *
 *   npm run test:vendors
 */
import { readFileSync, readdirSync, statSync } from 'fs';
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

import {
    ApproveVendorKycSchema,
    ListVendorActivityQuerySchema,
    ListVendorProductsQuerySchema,
    RejectVendorKycSchema,
    SearchVendorsQuerySchema,
    SuspendVendorProductSchema,
    SuspendVendorSchema,
    UpdateVendorSettingsSchema,
    VENDOR_AUDIT_ACTIONS,
    VENDOR_PRODUCT_SORT,
    VENDOR_SORT,
} from '../../src/modules/vendors/validators/vendor.validator';
import { buildFilter } from '../../src/modules/vendors/repositories/vendor.read.repository';
import { buildProductFilter } from '../../src/modules/vendors/repositories/vendor-product.read.repository';
import { AUDIT_CATALOG, auditSpec, isAuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { PERMISSION_CATALOG, permissionSpec } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { isSensitive } from '../../src/modules/authorization/domain/permission.types';
import { PLATFORM_COLLECTIONS } from '../../src/infra/platform/platform-collections';
import { routeManifest } from '../../src/api/route-manifest';
// Importing the router registers its eleven routes into the manifest — the same source
// the boot assertion reads, so §8 checks what Express will actually serve.
import '../../src/modules/vendors/routes/vendor.routes';

const t = suite('vendor management');

const SRC = join(__dirname, '..', '..', 'src');
const MODULE = join(SRC, 'modules', 'vendors');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');

function read(...segments: string[]): string {
    return readFileSync(join(...segments), 'utf8');
}

/**
 * Read a file with its comments removed.
 *
 * Every source scan below must run on code, not prose. These files explain the rule they
 * follow by naming the anti-pattern — `vendor.read.repository.ts` says a bare
 * `kyc_details: 1` would ship the identity number — and a scan over raw text reports the
 * explanation as the violation.
 */
function readCode(...segments: string[]): string {
    return read(...segments)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

/** Every `.ts` file in the vendors module, comment-stripped — for the §5 sweeps. */
function moduleSources(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry.endsWith('.ts')) files.push(readCode(full));
        }
    };
    walk(MODULE);
    return files;
}

const MODULE_CODE = moduleSources();

function query(overrides: Record<string, unknown> = {}) {
    return SearchVendorsQuerySchema.parse(overrides) as never;
}

function productQuery(overrides: Record<string, unknown> = {}) {
    return ListVendorProductsQuerySchema.parse(overrides) as never;
}

/** The `$and` array of a composed filter, or [] when it is a single flat clause. */
function conjuncts(filter: Record<string, unknown>): Record<string, unknown>[] {
    return (filter.$and as Record<string, unknown>[] | undefined) ?? [];
}

const VENDOR_ID = '0123456789abcdef01234567';

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The list query');

t.assert('paginates by default — page 1, 20 rows', () => {
    const parsed = SearchVendorsQuerySchema.parse({});
    return parsed.page === 1 && parsed.limit === 20;
});

t.assert('orders newest-first by default', () => {
    const parsed = SearchVendorsQuerySchema.parse({});
    return parsed.sort.field === 'createdAt' && parsed.sort.direction === -1;
});

t.assert('refuses a page size above the platform cap', () =>
    throws(() => SearchVendorsQuerySchema.parse({ limit: '101' })));

t.assert('refuses a sort key that is not in VENDOR_SORT', () =>
    throws(() => SearchVendorsQuerySchema.parse({ sort: 'payout_details' })));

t.assert('every VENDOR_SORT entry maps to a non-empty field path', () =>
    Object.values(VENDOR_SORT).every((path) => typeof path === 'string' && path.length > 0));

t.assert('does NOT offer business name as a sort key — it lives on another collection', () =>
    !('businessName' in VENDOR_SORT) && !('name' in VENDOR_SORT));

t.assert('accepts jovi-mall’s three vendor statuses and no fourth', () => {
    const ok = ['active', 'pending_verification', 'inactive']
        .every((status) => SearchVendorsQuerySchema.parse({ status }).status === status);
    return ok && throws(() => SearchVendorsQuerySchema.parse({ status: 'suspended' }));
});

t.assert('accepts the three KYC verdicts and no fourth', () => {
    const ok = ['pending', 'verified', 'rejected']
        .every((kycStatus) => SearchVendorsQuerySchema.parse({ kycStatus }).kycStatus === kycStatus);
    return ok && throws(() => SearchVendorsQuerySchema.parse({ kycStatus: 'approved' }));
});

t.assert('accepts the onboarding filter and refuses anything else', () =>
    SearchVendorsQuerySchema.parse({ onboarding: 'complete' }).onboarding === 'complete'
    && throws(() => SearchVendorsQuerySchema.parse({ onboarding: 'partial' })));

t.assert('uppercases a two-letter country and refuses other lengths', () =>
    SearchVendorsQuerySchema.parse({ country: 'cm' }).country === 'CM'
    && throws(() => SearchVendorsQuerySchema.parse({ country: 'CMR' })));

t.assert('refuses a search term longer than 120 characters', () =>
    throws(() => SearchVendorsQuerySchema.parse({ search: 'x'.repeat(121) })));

t.assert('refuses an inverted date range', () =>
    throws(() => SearchVendorsQuerySchema.parse({
        from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z',
    })));

t.assert('refuses a range wider than a year', () =>
    throws(() => SearchVendorsQuerySchema.parse({
        from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z',
    })));

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The vendor filter');

t.assert('no filters means no constraint', () =>
    Object.keys(buildFilter(query())).length === 0);

t.assert('one filter stays flat — no needless $and', () => {
    const filter = buildFilter(query({ status: 'inactive' })) as Record<string, unknown>;
    return filter.status === 'inactive' && !('$and' in filter);
});

t.assert('two filters compose under $and', () => {
    const filter = buildFilter(query({ status: 'active', country: 'CM' })) as Record<string, unknown>;
    return conjuncts(filter).length === 2;
});

t.assert('⭐ a search NEVER replaces another clause — both survive under $and', () => {
    const filter = buildFilter(query({ status: 'active', search: 'acme' })) as Record<string, unknown>;
    const parts = conjuncts(filter);
    return parts.length === 2
        && parts.some((clause) => clause.status === 'active')
        && parts.some((clause) => Array.isArray(clause.$or));
});

t.assert('⭐ TWO $or-shaped clauses coexist — search alongside kycStatus=pending', () => {
    const filter = buildFilter(query({ kycStatus: 'pending', search: 'acme' })) as Record<string, unknown>;
    const parts = conjuncts(filter);
    // Three clauses would mean one was dropped or merged; two `$or`s must both be present.
    return parts.length === 2 && parts.filter((clause) => Array.isArray(clause.$or)).length === 2;
});

t.assert('a plain term searches display name, email and phone', () => {
    const filter = buildFilter(query({ search: 'acme' })) as Record<string, unknown>;
    const branches = filter.$or as Record<string, unknown>[];
    return branches.length === 3
        && branches.some((b) => 'display_name' in b)
        && branches.some((b) => 'email' in b)
        && branches.some((b) => 'phone' in b);
});

t.assert('⭐ a 24-hex term adds BOTH the vendor id and the user id branch', () => {
    const filter = buildFilter(query({ search: VENDOR_ID })) as Record<string, unknown>;
    const branches = filter.$or as Record<string, unknown>[];
    return branches.some((b) => '_id' in b) && branches.some((b) => 'user_id' in b);
});

t.assert('pre-resolved store matches arrive as an _id $in branch', () => {
    const { ObjectId } = require('mongodb');
    const filter = buildFilter(query({ search: 'acme' }), [new ObjectId(VENDOR_ID)]) as Record<string, unknown>;
    const branches = filter.$or as Record<string, unknown>[];
    return branches.some((b) => {
        const id = b._id as { $in?: unknown[] } | undefined;
        return Array.isArray(id?.$in);
    });
});

t.assert('regex metacharacters in a search term are escaped', () => {
    const filter = buildFilter(query({ search: 'a.b' })) as Record<string, unknown>;
    const branches = filter.$or as Record<string, unknown>[];
    const pattern = branches[0].display_name as RegExp;
    return pattern.source.includes('a\\.b');
});

t.assert('the schema refuses a blank search rather than passing one down', () =>
    throws(() => SearchVendorsQuerySchema.parse({ search: '   ' })));

t.assert('and the filter guards against one anyway, belt and braces', () =>
    // Constructed directly, bypassing the schema: `buildFilter` is exported and a future
    // caller might not parse first. Its own `.trim()` check is what makes that safe.
    Object.keys(buildFilter({ search: '   ', page: 1, limit: 20, sort: { field: 'created_at', direction: -1 } })).length === 0);

t.assert('the created_at range is half-open — $gte / $lt', () => {
    const filter = buildFilter(query({
        from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z',
    })) as Record<string, unknown>;
    const range = filter.created_at as Record<string, unknown>;
    return '$gte' in range && '$lt' in range && !('$lte' in range);
});

t.assert('onboarding=complete means step 0, incomplete means anything else', () => {
    const complete = buildFilter(query({ onboarding: 'complete' })) as Record<string, unknown>;
    const incomplete = buildFilter(query({ onboarding: 'incomplete' })) as Record<string, unknown>;
    return complete.onboarding_step === 0
        && (incomplete.onboarding_step as Record<string, unknown>).$ne === 0;
});

t.assert('kycStatus=verified reads the boolean that has always been written', () => {
    const filter = buildFilter(query({ kycStatus: 'verified' })) as Record<string, unknown>;
    return filter['kyc_details.legit_verified'] === true;
});

t.assert('⭐ kycStatus=pending also matches rows written before the verdict existed', () => {
    const filter = buildFilter(query({ kycStatus: 'pending' })) as Record<string, unknown>;
    const branches = filter.$or as Record<string, unknown>[];
    return branches.length === 2
        && branches.some((b) => b['kyc_details.status'] === 'pending')
        && branches.some((b) => {
            const exists = b['kyc_details.status'] as Record<string, unknown> | undefined;
            return exists?.$exists === false;
        });
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The product filter');

t.assert('⭐ pins deletedAt: null for the EMPTY query', () => {
    const parts = conjuncts(buildProductFilter(VENDOR_ID, productQuery()) as Record<string, unknown>);
    return parts.some((clause) => clause.deletedAt === null);
});

t.assert('⭐ pins deletedAt: null for every filtered query too', () => {
    const parts = conjuncts(buildProductFilter(VENDOR_ID, productQuery({
        status: 'suspended', type: 'digital', search: 'x',
    })) as Record<string, unknown>);
    return parts.some((clause) => clause.deletedAt === null);
});

t.assert('always scopes to the vendor in the path', () => {
    const parts = conjuncts(buildProductFilter(VENDOR_ID, productQuery()) as Record<string, unknown>);
    return parts.some((clause) => 'vendorId' in clause);
});

t.assert('⭐ mode=advanced also matches documents predating the field', () => {
    const parts = conjuncts(buildProductFilter(VENDOR_ID, productQuery({ mode: 'advanced' })) as Record<string, unknown>);
    const modeClause = parts.find((clause) => Array.isArray(clause.$or)
        && (clause.$or as Record<string, unknown>[]).some((b) => b.mode === 'advanced'));
    const branches = modeClause?.$or as Record<string, unknown>[] | undefined;
    return !!branches && branches.some((b) => {
        const exists = b.mode as Record<string, unknown> | undefined;
        return exists?.$exists === false;
    });
});

t.assert('mode=simple does not carry the absent-key fallback', () => {
    const parts = conjuncts(buildProductFilter(VENDOR_ID, productQuery({ mode: 'simple' })) as Record<string, unknown>);
    return parts.some((clause) => clause.mode === 'simple');
});

t.assert('filters by suspension reason with a dotted path', () => {
    const parts = conjuncts(buildProductFilter(VENDOR_ID, productQuery({
        suspensionReason: 'platform_oversight',
    })) as Record<string, unknown>);
    return parts.some((clause) => clause['suspension.reason'] === 'platform_oversight');
});

t.assert('refuses a suspension reason outside jovi-mall’s closed set', () =>
    throws(() => ListVendorProductsQuerySchema.parse({ suspensionReason: 'because_i_said_so' })));

t.assert('⭐ VENDOR_PRODUCT_SORT is camelCase on both sides — products uses timestamps:true', () =>
    VENDOR_PRODUCT_SORT.createdAt === 'createdAt' && VENDOR_PRODUCT_SORT.updatedAt === 'updatedAt');

t.assert('the vendor list sort is snake_case — vendors maps its timestamps', () =>
    VENDOR_SORT.createdAt === 'created_at' && VENDOR_SORT.updatedAt === 'updated_at');

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. The write bodies');

t.assert('suspend requires a reason of real length, trimmed', () =>
    throws(() => SuspendVendorSchema.parse({}))
    && throws(() => SuspendVendorSchema.parse({ reason: '  x  ' }))
    && SuspendVendorSchema.parse({ reason: '  fraudulent listings  ' }).reason === 'fraudulent listings');

t.assert('KYC rejection requires a reason; approval does not', () =>
    throws(() => RejectVendorKycSchema.parse({}))
    && ApproveVendorKycSchema.parse({}).note === undefined);

t.assert('a product takedown requires a note — it is what the vendor is shown', () =>
    throws(() => SuspendVendorProductSchema.parse({}))
    && SuspendVendorProductSchema.parse({ note: 'counterfeit' }).note === 'counterfeit');

t.assert('settings PATCH refuses an empty body', () =>
    throws(() => UpdateVendorSettingsSchema.parse({})));

t.assert('⭐ settings PATCH refuses customerFlags — the vendor’s own CRM vocabulary', () =>
    throws(() => UpdateVendorSettingsSchema.parse({ customerFlags: [] })));

t.assert('⭐ settings PATCH refuses notifyDaysBeforeExpiry — it notifies only the vendor', () =>
    throws(() => UpdateVendorSettingsSchema.parse({ notifyDaysBeforeExpiry: 14 })));

t.assert('⭐ settings PATCH refuses commission — that is the billing plan’s', () =>
    throws(() => UpdateVendorSettingsSchema.parse({ commission: 5 }))
    && throws(() => UpdateVendorSettingsSchema.parse({ commissionPercent: 5 })));

t.assert('autoCancelUnpaidDays bounds match jovi-mall’s own min 1 / max 90', () =>
    throws(() => UpdateVendorSettingsSchema.parse({ autoCancelUnpaidDays: 0 }))
    && throws(() => UpdateVendorSettingsSchema.parse({ autoCancelUnpaidDays: 91 }))
    && UpdateVendorSettingsSchema.parse({ autoCancelUnpaidDays: 7 }).autoCancelUnpaidDays === 7);

t.assert('autoRedirectThresholdAmount accepts null to clear, refuses a negative', () =>
    UpdateVendorSettingsSchema.parse({ autoRedirectThresholdAmount: null })
        .autoRedirectThresholdAmount === null
    && throws(() => UpdateVendorSettingsSchema.parse({ autoRedirectThresholdAmount: -1 })));

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. What leaves the database');

t.assert('⭐ payout_details appears nowhere in the module', () =>
    MODULE_CODE.every((code) => !code.includes('payout_details')));

t.assert('⭐ national_id_number appears nowhere in the module', () =>
    MODULE_CODE.every((code) => !code.includes('national_id_number')));

t.assert('⭐ no projection names the whole kyc_details sub-document', () =>
    MODULE_CODE.every((code) => !/\bkyc_details\s*:\s*1\b/.test(code)));

t.assert('the KYC flag is projected by its dotted path instead', () =>
    readCode(MODULE, 'repositories', 'vendor.read.repository.ts')
        .includes("'kyc_details.legit_verified': 1"));

t.assert('⭐ business address geo/coordinates are never projected', () =>
    MODULE_CODE.every((code) =>
        !code.includes('business_addresses.geo') && !code.includes('business_addresses.location')));

t.assert('no projection uses an exclusion — whitelists only', () =>
    MODULE_CODE.every((code) => !/^\s*\w+:\s*0,\s*$/m.test(code.replace(/_id: 0/g, ''))));

t.assert('the product projection reads suspension by dotted paths', () =>
    readCode(MODULE, 'repositories', 'vendor-product.read.repository.ts')
        .includes("'suspension.reason': 1"));

t.assert('⭐ only the gateway may call platformRequest', () => {
    const gateway = readCode(MODULE, 'gateways', 'vendor.gateway.ts');
    const others = [
        readCode(MODULE, 'controllers', 'vendor.controller.ts'),
        readCode(MODULE, 'repositories', 'vendor.read.repository.ts'),
        readCode(MODULE, 'repositories', 'vendor-product.read.repository.ts'),
        readCode(MODULE, 'repositories', 'store.read.repository.ts'),
        readCode(MODULE, 'repositories', 'vendor-context.read.repository.ts'),
    ];
    return gateway.includes('platformRequest')
        && others.every((code) => !code.includes('platformRequest'));
});

t.assert('the orders read carries no amount field — a tally, never revenue', () =>
    !readCode(MODULE, 'repositories', 'vendor-context.read.repository.ts').includes('total_amount'));

t.assert('customer_flags is not projected — the vendor’s own CRM vocabulary', () =>
    !readCode(MODULE, 'repositories', 'vendor-context.read.repository.ts')
        .includes('customer_flags: 1'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. Suspension is enforced in jovi-mall, and enforced narrowly');

t.assert('⭐ requireAuth refuses a vendor whose role entity is inactive', () => {
    const code = readCode(JOVI, 'api', 'middlewares', 'auth.middleware.ts');
    return code.includes('AUTH_VENDOR_SUSPENDED') && code.includes("role === 'vendor'");
});

t.assert('⭐ ...with === "inactive", NOT !== "active" — the mass-lockout guard', () => {
    const code = readCode(JOVI, 'api', 'middlewares', 'auth.middleware.ts');
    // `pending_verification` is the registration default, so the negated form would refuse
    // every vendor who never verified their email. If somebody "tidies" this, fail here.
    return code.includes(".status === 'inactive'")
        && !/role_entity[\s\S]{0,80}!==\s*'active'/.test(code);
});

t.assert('login refuses one too, so no token pair is issued that cannot be used', () =>
    readCode(JOVI, 'modules', 'auth', 'auth.service.ts').includes('AUTH_VENDOR_SUSPENDED'));

t.assert('the vendor status write is a compare-and-set', () => {
    const code = readCode(JOVI, 'modules', 'vendors', 'vendor.repository.ts');
    return code.includes('applyStatusChangeIfCurrent') && code.includes('status: fromStatus');
});

t.assert('the dead updateStatus is gone — one way to move a vendor’s status', () =>
    !readCode(JOVI, 'modules', 'vendors', 'vendor.repository.ts').includes('async updateStatus'));

t.assert('⭐ markEmailVerified can no longer reinstate a suspended vendor', () => {
    const code = readCode(JOVI, 'modules', 'vendors', 'vendor.repository.ts');
    // It must be conditional on `pending_verification`, not an unconditional 'active'.
    return code.includes("$eq: ['$status', 'pending_verification']")
        && !/markEmailVerified[\s\S]{0,400}\$set:\s*\{\s*email_verified:\s*true,\s*status:\s*'active'/.test(code);
});

t.assert('⭐ setKycVerdict writes only the real field, never the stripped top-level one', () => {
    const code = readCode(JOVI, 'modules', 'vendors', 'vendor.repository.ts');
    return code.includes("'kyc_details.legit_verified'")
        && !/\n\s+legit_verified:\s/.test(code);
});

t.assert('the deprecated top-level legit_verified is gone from the vendor model', () => {
    const raw = read(JOVI, 'modules', 'vendors', 'vendor.model.ts');
    const code = readCode(JOVI, 'modules', 'vendors', 'vendor.model.ts');
    // `IVendorKycDetails.legit_verified` is the REAL field and must stay, so this cannot
    // just grep the name. Two precise checks instead: the `@deprecated` marker that only
    // ever described the top-level mirror is gone, and `IVendor` no longer declares it —
    // matched by the field's old neighbours rather than the field alone.
    return !raw.includes('@deprecated Use kyc_details.legit_verified')
        && !/policy_version:\s*number;\s*\n\s*legit_verified/.test(code);
});

t.assert('the vendor collection gained the indexes its admin list needs', () => {
    const code = readCode(JOVI, 'modules', 'vendors', 'vendor.model.ts');
    return code.includes('{ status: 1, created_at: -1 }')
        && code.includes("'kyc_details.status': 1");
});

t.assert('⭐ the two new suspension reasons are in NEITHER existing sweep', () => {
    const agency = readCode(JOVI, 'modules', 'catalog', 'domain', 'services', 'ProductDeliveryAgencySuspensionService.ts');
    const storage = readCode(JOVI, 'modules', 'inventory', 'domain', 'services', 'agency-storage-suspension.service.ts');
    const reasons = ['vendor_suspended', 'platform_oversight'];
    return reasons.every((reason) => !agency.includes(reason) && !storage.includes(reason));
});

t.assert('DELIVERY_AGENCY_REASONS still has exactly its original three members', () => {
    const code = readCode(JOVI, 'modules', 'catalog', 'domain', 'services', 'ProductDeliveryAgencySuspensionService.ts');
    const line = code.split('\n').find((l) => l.includes('DELIVERY_AGENCY_REASONS =')) ?? '';
    return line.split(',').length === 3;
});

t.assert('⭐ the vendor restore sweep scans ONLY its own reason', () => {
    const code = readCode(JOVI, 'modules', 'catalog', 'domain', 'services', 'ProductPlatformSuspensionService.ts');
    return /findSuspendedByVendorAndReasons\(\s*vendorId,\s*\[VENDOR_SUSPENDED_REASON\]/.test(code);
});

t.assert('⭐ the oversight restore refuses a product suspended for any other reason', () =>
    readCode(JOVI, 'modules', 'catalog', 'domain', 'services', 'ProductPlatformSuspensionService.ts')
        .includes('product.suspension?.reason !== PLATFORM_OVERSIGHT_REASON'));

t.assert('⭐ the activation gate blocks while the VENDOR is suspended', () => {
    const code = readCode(JOVI, 'modules', 'catalog', 'domain', 'services', 'ProductStatusValidationService.ts');
    return code.includes('CATALOG_PRODUCT_VENDOR_SUSPENDED')
        && code.includes("vendor?.status === 'inactive'");
});

t.assert('the vendor cascade covers every product type, not just physical', () => {
    const code = readCode(JOVI, 'modules', 'catalog', 'domain', 'services', 'ProductPlatformSuspensionService.ts');
    return code.includes("['physical', 'digital', 'service']");
});

t.assert('the suspension reason enum is derived from its union, not hand-maintained', () => {
    const code = readCode(JOVI, 'modules', 'catalog', 'models', 'product.model.ts');
    return code.includes('enum: [...PRODUCT_SUSPENSION_REASONS]');
});

t.assert('the internal vendor router is mounted for wi-admin', () =>
    readCode(JOVI, 'api', 'routes', 'internal-admin.routes.ts')
        .includes("router.use('/vendors', buildAdminVendorRouter"));

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Permissions');

const VENDOR_PERMISSIONS = [
    'vendors.read',
    'vendors.kyc.review',
    'vendors.suspend',
    'vendors.products.manage',
    'vendors.settings.manage',
] as const;

t.assert('all five vendor permissions exist in the catalog', () =>
    VENDOR_PERMISSIONS.every((name) => name in PERMISSION_CATALOG));

t.assert('⭐ none is flagged sensitive — allInFamily would drop it from tier 2 silently', () =>
    VENDOR_PERMISSIONS.every((name) => !isSensitive(permissionSpec(name))));

t.assert('Support holds the read and none of the writes', () => {
    const support = new Set(TIER_GRANTS[3]);
    return support.has('vendors.read')
        && VENDOR_PERMISSIONS.filter((n) => n !== 'vendors.read').every((n) => !support.has(n));
});

t.assert('Admin holds all five', () => {
    const admin = new Set(TIER_GRANTS[2]);
    return VENDOR_PERMISSIONS.every((name) => admin.has(name));
});

t.assert('the settings permission no longer claims to govern commission', () =>
    !permissionSpec('vendors.settings.manage').summary.toLowerCase().includes('commission —')
    && permissionSpec('vendors.settings.manage').summary.includes('not their commission'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. Routes, audit catalog and the access table');

// The manifest records the FULL path Express will match, so `/vendors` is matched as a
// prefix under `/api/v1` rather than as a separate `mountedAt` field.
const vendorRouteDecls = routeManifest().filter((route) =>
    route.fullPath === '/api/v1/vendors' || route.fullPath.startsWith('/api/v1/vendors/'));

t.assert('eleven routes are declared', () => vendorRouteDecls.length === 11);

t.assert('every one carries a permission — none is public or self-service', () =>
    vendorRouteDecls.every((route) => route.access.kind === 'permission'));

t.assert('the four reads need vendors.read', () => {
    const reads = vendorRouteDecls.filter((route) => route.method === 'get');
    return reads.length === 4 && reads.every((route) =>
        route.access.kind === 'permission' && route.access.permissions.includes('vendors.read'));
});

t.assert('⭐ the activity feed needs audit.read as well, in `all` mode', () => {
    const feed = vendorRouteDecls.find((route) => route.fullPath.endsWith('/:vendorId/activity'));
    return !!feed && feed.access.kind === 'permission'
        && feed.access.mode === 'all'
        && feed.access.permissions.includes('vendors.read')
        && feed.access.permissions.includes('audit.read');
});

t.assert('suspend and restore share one permission', () => {
    const pair = vendorRouteDecls.filter((route) => /\/(suspend|restore)$/.test(route.fullPath)
        && !route.fullPath.includes('products'));
    return pair.length === 2 && pair.every((route) =>
        route.access.kind === 'permission' && route.access.permissions[0] === 'vendors.suspend');
});

t.assert('no route file registers a route directly on the router', () =>
    !/\brouter\.(get|post|put|patch|delete)\s*\(/.test(readCode(MODULE, 'routes', 'vendor.routes.ts')));

t.assert('seven vendors.* audit actions exist', () =>
    Object.keys(AUDIT_CATALOG).filter((action) => action.startsWith('vendors.')).length === 7);

t.assert('every one targets the vendor and is delegated', () =>
    Object.keys(AUDIT_CATALOG)
        .filter((action) => action.startsWith('vendors.'))
        .every((action) => {
            const spec = auditSpec(action as never);
            return spec.target === 'vendor' && spec.transport === 'delegated';
        }));

t.assert('every one names a permission in its own family', () =>
    Object.keys(AUDIT_CATALOG)
        .filter((action) => action.startsWith('vendors.'))
        .every((action) => auditSpec(action as never).permission?.startsWith('vendors.')));

t.assert('reinstate is its own action, not a flag on suspend', () =>
    isAuditAction('vendors.reinstate')
    && auditSpec('vendors.reinstate').permission === 'vendors.suspend');

t.assert('a vendor is a platform actor, so Support may read its feed', () =>
    subjectClassOf('vendor') === 'platform_actor');

t.assert('⭐ the activity filter is DERIVED from the catalog, not typed out', () =>
    VENDOR_AUDIT_ACTIONS.length === 7
    && VENDOR_AUDIT_ACTIONS.every((action) => action.startsWith('vendors.')));

t.assert('the feed refuses another domain’s action and accepts every vendor one', () =>
    throws(() => ListVendorActivityQuerySchema.parse({ action: 'users.suspend' }))
    && VENDOR_AUDIT_ACTIONS.every((action) =>
        ListVendorActivityQuerySchema.parse({ action }).action === action));

t.assert('the three newly-read collections are declared read / internal-api', () => {
    const added = ['stores', 'vendor_settings', 'vendor_agency_connections'] as const;
    return added.every((name) => {
        const spec = (PLATFORM_COLLECTIONS as Record<string, { access: string; writes: string; note: string }>)[name];
        return spec?.access === 'read' && spec.writes === 'internal-api' && spec.note.length > 0;
    });
});

t.assert('no collection became owned — still exactly the two blog ones', () =>
    Object.values(PLATFORM_COLLECTIONS as Record<string, { access: string }>)
        .filter((spec) => spec.access === 'owned').length === 2);

process.exit(t.finish());

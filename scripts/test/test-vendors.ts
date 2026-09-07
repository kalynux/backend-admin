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
    CONNECTION_STATUSES,
    ListVendorActivityQuerySchema,
    ListVendorAgenciesQuerySchema,
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
import {
    buildConnectionFilter,
    VENDOR_AGENCY_CONNECTION_SORT,
} from '../../src/modules/vendors/repositories/vendor-context.read.repository';
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
/** Two distinct agencies — the resolved-agency filter branches on which is the default. */
const AGENCY_ID = '665c0011223344556677889a';
const OTHER_AGENCY_ID = '665c0011223344556677889b';

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
t.section('3b. The delivery-agency connections (BR-018)');

function connectionQuery(overrides: Record<string, unknown> = {}) {
    return ListVendorAgenciesQuerySchema.parse(overrides) as never;
}

t.assert('paginates by default — page 1, 20 rows, newest first', () => {
    const parsed = ListVendorAgenciesQuerySchema.parse({});
    return parsed.page === 1 && parsed.limit === 20
        && parsed.sort.field === 'createdAt' && parsed.sort.direction === -1;
});

t.assert('refuses a page size above the platform cap', () =>
    throws(() => ListVendorAgenciesQuerySchema.parse({ limit: '101' })));

t.assert('offers createdAt and status as sort keys, and nothing else', () => {
    const keys = Object.keys(VENDOR_AGENCY_CONNECTION_SORT);
    return keys.length === 2 && keys.includes('createdAt') && keys.includes('status')
        && throws(() => ListVendorAgenciesQuerySchema.parse({ sort: 'productCount' }));
});

t.assert('the connection sort is snake_case — this collection maps its timestamps', () =>
    VENDOR_AGENCY_CONNECTION_SORT.createdAt === 'created_at');

/**
 * ⭐ ADR-005 D-17: a vocabulary this service does not own is validated for SHAPE, not
 * membership — the opposite call from `PRODUCT_STATUSES` above, and the same call
 * `ListRosterQuerySchema` makes for contract status. A pinned copy here means a seventh
 * `ConnectionStatus` added in jovi-mall is silently unfilterable until somebody remembers
 * this file, and the failure mode of that drift is a filter that matches nothing.
 */
t.assert('⭐ status is bounded, not pinned — the vocabulary is jovi-mall’s', () =>
    CONNECTION_STATUSES.every((status) =>
        ListVendorAgenciesQuerySchema.parse({ status }).status === status)
    && ListVendorAgenciesQuerySchema.parse({ status: 'a_seventh_status' }).status === 'a_seventh_status'
    && throws(() => ListVendorAgenciesQuerySchema.parse({ status: '   ' })));

t.assert('CONNECTION_STATUSES still lists jovi-mall’s six', () => {
    const model = readCode(JOVI, 'modules', 'agency-connections', 'connection.model.ts');
    return CONNECTION_STATUSES.length === 6
        && CONNECTION_STATUSES.every((status) => model.includes(`'${status}'`));
});

t.assert('always scopes to the vendor in the path', () => {
    const filter = buildConnectionFilter(VENDOR_ID, connectionQuery()) as Record<string, unknown>;
    return 'vendor_id' in filter;
});

t.assert('every status by default — a rejected row is what the panel exists to explain', () => {
    const filter = buildConnectionFilter(VENDOR_ID, connectionQuery()) as Record<string, unknown>;
    return !('status' in filter);
});

t.assert('the status filter narrows without dropping the vendor scope', () => {
    const filter = buildConnectionFilter(
        VENDOR_ID, connectionQuery({ status: 'paused_reapproval' }),
    ) as Record<string, unknown>;
    return filter.status === 'paused_reapproval' && 'vendor_id' in filter;
});

t.assert('a malformed id matches nothing rather than throwing in the repository', () => {
    const filter = buildConnectionFilter('not-an-id', {
        page: 1, limit: 20, sort: { field: 'createdAt', direction: -1 },
    }) as Record<string, unknown>;
    return filter.vendor_id === 'not-an-id';
});

/**
 * ⭐ The row read may only ADD to the four fields the counts already use.
 *
 * `aggregatePage` spreads the repository's own projection first and refuses an exclusion,
 * so the narrow one stays the default. What this pins is the other half: the extras must
 * not have quietly grown a whole-document grab.
 */
t.assert('⭐ status_history is projected nowhere — a list row does not carry a trail', () =>
    MODULE_CODE.every((code) => !code.includes('status_history')));

t.assert('the row extras are named individually, never as a whole document', () => {
    const code = readCode(MODULE, 'repositories', 'vendor-context.read.repository.ts');
    return code.includes('requester_role: 1')
        && code.includes('paused_reason: 1')
        && !/CONNECTION_ROW_EXTRAS[\s\S]{0,600}\$\$ROOT/.test(code);
});

/**
 * ⭐ BR-006's distinction, on a third surface.
 *
 * `display_name` on a `delivery_agencies` row is a contact PERSON; the business name is
 * the Magazin's. The dashboard reported a column headed "Agency" rendering a human's name
 * because it was the only name on the payload, and the fix is worthless if the next DTO
 * substitutes one for the other again.
 */
t.assert('⭐ businessName is the Magazin’s and contactName is display_name — never swapped', () => {
    const dto = readCode(MODULE, 'read-models', 'vendor-agency-connection.dto.ts');
    return /businessName:\s*agency\.magazin\?\.name\s*\?\?\s*null/.test(dto)
        && /contactName:\s*agency\.display_name\s*\?\?\s*null/.test(dto);
});

t.assert('⭐ businessName falls back to null, never to "" and never to the contact name', () => {
    const dto = readCode(MODULE, 'read-models', 'vendor-agency-connection.dto.ts');
    return !/businessName:[^\n]*display_name/.test(dto)
        && !/businessName:[^\n]*''/.test(dto);
});

/**
 * ⭐ The `dispute` pattern from `GET /orders/:orderId`: an event that did not happen is
 * `null`, not a block of null fields that reads as "unknown".
 */
t.assert('⭐ rejection, withdrawal and termination are whole objects or null', () => {
    const dto = readCode(MODULE, 'read-models', 'vendor-agency-connection.dto.ts');
    return ['rejection', 'withdrawal', 'termination'].every((field) =>
        new RegExp(`${field}:\\s*${field}\\s*\\n?\\s*\\?`).test(dto))
        && /:\s*null,\s*\n\s*(withdrawal|termination|createdAt)/.test(dto);
});

t.assert('reapproval stays a block — it is a STATE, not an event', () => {
    const dto = readCode(MODULE, 'read-models', 'vendor-agency-connection.dto.ts');
    return /reapproval:\s*\{\s*\n\s*requiredFrom:/.test(dto);
});

t.assert('the DTO maps field by field — no spread of a read model', () => {
    const dto = readCode(MODULE, 'read-models', 'vendor-agency-connection.dto.ts');
    return !/\.\.\.\s*(connection|agency)\b/.test(dto);
});

t.assert('no snake_case key reaches the wire shape', () => {
    const dto = readCode(MODULE, 'read-models', 'vendor-agency-connection.dto.ts');
    // Every `x_y:` in this file is a READ of jovi-mall's document; none may be a key of
    // the returned object literal, which is what an assignment to a snake_case key is.
    return !/^\s+[a-z]+_[a-z_]+:\s*(str|num|toIso|connection|agency)/m.test(dto);
});

// ── productCount: one aggregation for the page, never one count per row ──────

t.assert('⭐ the tally is ONE $group, not a countDocuments per connection', () => {
    const code = readCode(MODULE, 'repositories', 'vendor-product.read.repository.ts');
    const method = code.slice(code.indexOf('async countByResolvedAgency'));
    return method.includes('$group')
        && !method.slice(0, method.indexOf('\n    }')).includes('countBy(');
});

t.assert('⭐ the tally pins deletedAt: null — a soft-deleted listing is not counted', () => {
    const code = readCode(MODULE, 'repositories', 'vendor-product.read.repository.ts');
    const method = code.slice(code.indexOf('async countByResolvedAgency'));
    return /\$match:\s*\{\s*vendorId:[^}]*deletedAt:\s*null/.test(method);
});

t.assert('⭐ ONE definition of the resolved agency, shared by the DTO and the tally', () => {
    const repo = readCode(MODULE, 'repositories', 'vendor-product.read.repository.ts');
    const controller = readCode(MODULE, 'controllers', 'vendor.controller.ts');
    return repo.includes('export function resolveDeliveryAgencyId')
        // The controller's `effectiveAgencyId` must DELEGATE, not restate the `??` chain.
        && /function effectiveAgencyId[\s\S]{0,300}resolveDeliveryAgencyId\(/.test(controller)
        && !/function effectiveAgencyId[\s\S]{0,300}product\.delivery\?\.agency_id\?\.toString\(\)\s*\?\?/.test(controller)
        && repo.includes('resolveDeliveryAgencyId(row._id');
});

// ── The drill-down: meta.total on the filtered page IS productCount ──────────

t.assert('the products list accepts a deliveryAgencyId and refuses a malformed one', () =>
    ListVendorProductsQuerySchema.parse({ deliveryAgencyId: VENDOR_ID }).deliveryAgencyId === VENDOR_ID
    && throws(() => ListVendorProductsQuerySchema.parse({ deliveryAgencyId: 'nope' })));

t.assert('⭐ filtering by a NON-default agency matches the override alone', () => {
    const parts = conjuncts(buildProductFilter(
        VENDOR_ID, productQuery({ deliveryAgencyId: AGENCY_ID }), OTHER_AGENCY_ID,
    ) as Record<string, unknown>);
    return parts.some((clause) => 'delivery.agency_id' in clause && !('$or' in clause));
});

/**
 * ⭐ The whole reason the filter takes the vendor's default as context.
 *
 * Most products carry no override at all, so "the default agency's listings" has to
 * include every product with no `delivery.agency_id`. Without this branch the column and
 * the drill-down disagree on the common case — and `productCount` would be right while
 * `meta.total` said zero.
 */
t.assert('⭐ filtering by the DEFAULT agency also matches products with no override', () => {
    const parts = conjuncts(buildProductFilter(
        VENDOR_ID, productQuery({ deliveryAgencyId: AGENCY_ID }), AGENCY_ID,
    ) as Record<string, unknown>);
    const branch = parts.find((clause) => Array.isArray(clause.$or));
    const branches = branch?.$or as Record<string, unknown>[] | undefined;
    return !!branches
        && branches.length === 2
        && branches.some((b) => b['delivery.agency_id'] === null);
});

t.assert('the agency filter never displaces the vendor scope or deletedAt', () => {
    const parts = conjuncts(buildProductFilter(
        VENDOR_ID, productQuery({ deliveryAgencyId: AGENCY_ID, search: 'x', mode: 'advanced' }), AGENCY_ID,
    ) as Record<string, unknown>);
    return parts.some((clause) => 'vendorId' in clause)
        && parts.some((clause) => clause.deletedAt === null)
        // Three `$or`-shaped clauses now coexist: mode, search and the resolved agency.
        && parts.filter((clause) => Array.isArray(clause.$or)).length === 3;
});

/**
 * The transport decision, pinned where it can be read.
 *
 * BR-018 proposed `Transport: Delegated`. It is a direct read, because a connection
 * document is a RECORD and ADR-004 D-2 (as amended by ADR-009 D-1 / ADR-011 D-1) delegates
 * only a verdict. The access table has said `read` since Phase 6; this asserts the handler
 * actually honours it rather than reaching for the gateway.
 */
t.assert('⭐ vendor_agency_connections is read DIRECTLY, not delegated', () => {
    const spec = (PLATFORM_COLLECTIONS as Record<string, { access: string; writes: string }>)
        .vendor_agency_connections;
    const controller = readCode(MODULE, 'controllers', 'vendor.controller.ts');
    const handler = controller.slice(controller.indexOf('static agencies ='));
    const body = handler.slice(0, handler.indexOf('\n    });'));
    return spec?.access === 'read'
        && spec.writes === 'internal-api'
        && body.includes('connections.listForVendor(')
        && !body.includes('gateway.');
});

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

// Eleven at Phase 6; twelve since the product detail landed; thirteen since the
// agency-connections panel (BR-018).
t.assert('thirteen routes are declared', () => vendorRouteDecls.length === 13);

t.assert('every one carries a permission — none is public or self-service', () =>
    vendorRouteDecls.every((route) => route.access.kind === 'permission'));

t.assert('the six reads need vendors.read', () => {
    const reads = vendorRouteDecls.filter((route) => route.method === 'get');
    return reads.length === 6 && reads.every((route) =>
        route.access.kind === 'permission' && route.access.permissions.includes('vendors.read'));
});

/**
 * The product detail is scoped by BOTH ids, and that is the authorisation.
 *
 * jovi-mall answers 404 when the product does not belong to the vendor in the path, so a
 * product id guessed from elsewhere cannot be read by naming a vendor the caller can see.
 * The same rule the two product writes already follow.
 */
t.assert('the product detail is scoped by vendor AND product', () => {
    const detail = vendorRouteDecls.find(
        (route) => route.method === 'get' && route.fullPath.endsWith('/products/:productId'),
    );
    return !!detail
        && detail.access.kind === 'permission'
        && detail.access.permissions.length === 1
        && detail.access.permissions[0] === 'vendors.read';
});

/**
 * ⚠ The one read on this module that is DELEGATED rather than a direct query.
 *
 * Not a drift from ADR-004 D-2 but a consequence of ADR-009 D-6: the payload needs
 * `storage.getPublicUrl` for its images and jovi-mall's storage-fee calculator for its
 * rent, and this service may own neither. If somebody "fixes" this into a direct read, the
 * images stop resolving and the storage figure becomes a second opinion.
 */
t.assert('...and it is served through the gateway, not a repository', () => {
    const controller = readCode(SRC, 'modules', 'vendors', 'controllers', 'vendor.controller.ts');
    const handler = controller.slice(controller.indexOf('static product ='));
    return handler.startsWith('static product =') && handler.includes('gateway.product(');
});

/**
 * ⭐ The connections panel needs `agencies.read` as well (BR-018).
 *
 * The rows name agencies and carry their business names, contact people and commercial
 * state, so `vendors.read` alone would be a second door onto the agency directory —
 * the same rule `/agencies/:agencyId/agents`, `/agents/:agentId/contracts` and
 * `/shipments/:shipmentId/offers` each state from their own side.
 */
t.assert('⭐ the agency-connections panel needs agencies.read too, in `all` mode', () => {
    const route = vendorRouteDecls.find((r) => r.fullPath.endsWith('/:vendorId/agencies'));
    return !!route && route.access.kind === 'permission'
        && route.access.mode === 'all'
        && route.access.permissions.length === 2
        && route.access.permissions.includes('vendors.read')
        && route.access.permissions.includes('agencies.read');
});

t.assert('...and it is not audited — a business relationship is not a disclosure', () => {
    const route = vendorRouteDecls.find((r) => r.fullPath.endsWith('/:vendorId/agencies'));
    return !!route && route.method === 'get' && route.audit === null;
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

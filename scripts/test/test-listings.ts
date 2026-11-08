/**
 * Informational service listings — wi-admin's review half (SERVICE-LISTINGS-PLAN § C-6).
 *
 * jovi-mall owns the listings, the hidden contacts and every write; this service reads the
 * queue directly, reads the contacts behind an audited permission, and delegates approve /
 * reject / suspend / unsuspend. What can break on THIS side, silently:
 *
 *   §1  the copied vocabularies drift from jovi-mall's `listing.types.ts`;
 *   §2  the permissions and tiers stop matching § C-6 (Support works the queue, never the refund);
 *   §3  the audit actions stop matching § C-6;
 *   §4  a route loses its permission or its audit action, or the mount moves;
 *   §5  ⛔ the contacts disclosure stops being fail-closed — read before audited, or a value
 *       reaches the audit store;
 *   §6  ⛔ a contact reaches any surface other than the contacts route — a projection names a
 *       contact field, a second reader of `listing_contacts` appears, a DTO forwards one;
 *   §7  the gateway's paths and bodies stop matching § C-3;
 *   §8  the request shapes (list leniency per the house rule, strict bodies, bounds);
 *   §9  the wire shapes (exact key sets, absent = null, the available actions).
 *
 * DB-free. Run: npm run test:listings
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
import { join, relative, resolve } from 'path';
import { ObjectId } from 'mongodb';
import { PERMISSION_CATALOG as PERMISSIONS } from '../../src/modules/authorization/domain/permission.catalog';
import { TIER_GRANTS } from '../../src/modules/authorization/domain/tier-grants';
import { AUDIT_CATALOG as AUDIT_ACTIONS } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { toAuditRow } from '../../src/modules/audit/domain/audit.writer';
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/listings/routes/listing.routes';
import {
    buildListingFilter,
    LISTING_DETAIL_PROJECTION,
    LISTING_LIST_PROJECTION,
    LISTING_SEARCH_FIELDS,
    ListingReadModel,
} from '../../src/modules/listings/repositories/listing.read.repository';
import {
    LISTING_FILE_PROJECTION,
    LISTING_VENDOR_PROJECTION,
} from '../../src/modules/listings/repositories/listing-context.read.repository';
import { LISTING_CONTACT_PROJECTION } from '../../src/modules/listings/repositories/listing-contact.read.repository';
import {
    availableActionsOf,
    toListingDetailDto,
    toListingQueueItemDto,
    vendorKindOf,
} from '../../src/modules/listings/read-models/listing.dto';
import { presentFieldsOf, toListingContactsDto } from '../../src/modules/listings/read-models/listing-contacts.dto';
import {
    ApproveListingSchema,
    LISTING_CONTACT_FIELDS,
    LISTING_REVIEW_STATES,
    LISTING_STATUSES,
    LISTING_SUSPENSION_REASONS,
    ListListingsQuerySchema,
    RejectListingSchema,
    SuspendListingSchema,
    UnsuspendListingSchema,
} from '../../src/modules/listings/validators/listing.validator';

const t = suite('listings');

const SRC = resolve(__dirname, '../../src');
const JOVI = resolve(__dirname, '../../../jovi-mall/src');
const MOD = join(SRC, 'modules', 'listings');
const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf-8');
/** Source with comments stripped, so prose can never satisfy (or trip) a scan. */
const code = (root: string, rel: string): string =>
    read(root, rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
}
const rel = (p: string): string => relative(SRC, p).replace(/\\/g, '/');

const OID = '507f1f77bcf86cd799439011';
const OID2 = '507f1f77bcf86cd799439012';

/** The seven sensitive field names — a key or a path segment matching one is a contact. */
const CONTACT_WORD = /\b(whatsapp|phone|email|website|socials|location|video)\b/i;

// ─── §1 ──────────────────────────────────────────────────────────────────────
t.section('§1 the copied vocabularies match jovi-mall');

const joviTypes = code(JOVI, 'modules/listings/domain/listing.types.ts');
const constArray = (name: string): string[] | null => {
    const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(joviTypes);
    return m ? Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]) : null;
};
const same = (a: readonly string[], b: string[] | null) => b !== null && JSON.stringify([...a]) === JSON.stringify(b);

t.assert('LISTING_STATUSES', () => same(LISTING_STATUSES, constArray('LISTING_STATUSES')));
t.assert('LISTING_REVIEW_STATES', () => same(LISTING_REVIEW_STATES, constArray('LISTING_REVIEW_STATES')));
t.assert('LISTING_SUSPENSION_REASONS', () => same(LISTING_SUSPENSION_REASONS, constArray('LISTING_SUSPENSION_REASONS')));
t.assert('LISTING_CONTACT_FIELDS (seven — the debt bound rests on the count)', () =>
    same(LISTING_CONTACT_FIELDS, constArray('LISTING_CONTACT_FIELDS')) && LISTING_CONTACT_FIELDS.length === 7);

// ─── §2 ──────────────────────────────────────────────────────────────────────
t.section('§2 permissions and tiers (§ C-6, O-12…O-14)');

type Spec = { family: string; action: string; financial?: boolean; destructive?: boolean; escalation?: boolean; dualControl?: unknown };
const spec = (name: string) => (PERMISSIONS as unknown as Record<string, Spec | undefined>)[name];
const LISTING_PERMISSIONS = [
    'catalog.listings.read',
    'catalog.listings.contacts.read',
    'catalog.listings.review',
    'catalog.listings.suspend',
    'catalog.listings.reveals.refund',
    'catalog.listings.reveal-block',
] as const;

for (const name of LISTING_PERMISSIONS) {
    t.assert(`${name} exists in the catalog family`, () => spec(name)?.family === 'catalog');
}
t.assert('only the refund is flagged, and it is `financial` (it moves credits)', () =>
    LISTING_PERMISSIONS.every((n) => {
        const s = spec(n)!;
        const flagged = Boolean(s.financial || s.destructive || s.escalation || s.dualControl);
        return n === 'catalog.listings.reveals.refund' ? s.financial === true && !s.destructive : !flagged;
    }));

const holds = (tier: 1 | 2 | 3, name: string) => (TIER_GRANTS[tier] as readonly string[]).includes(name);
t.assert('Support holds read, contacts.read, review, suspend and reveal-block (O-12…O-14)', () =>
    ['catalog.listings.read', 'catalog.listings.contacts.read', 'catalog.listings.review',
        'catalog.listings.suspend', 'catalog.listings.reveal-block'].every((n) => holds(3, n)));
t.assert('⛔ Support does NOT hold catalog.listings.reveals.refund', () => !holds(3, 'catalog.listings.reveals.refund'));
t.assert('Admin and Developer hold all six', () =>
    LISTING_PERMISSIONS.every((n) => holds(1, n) && holds(2, n)));

// ─── §3 ──────────────────────────────────────────────────────────────────────
t.section('§3 audit actions (§ C-6)');

type ASpec = { permission: string; target: string; transport: string };
const action = (name: string) => (AUDIT_ACTIONS as unknown as Record<string, ASpec | undefined>)[name];
const EXPECTED_ACTIONS: Array<[string, string, string, string]> = [
    ['catalog.listings.contacts.read', 'catalog.listings.contacts.read', 'listing', 'external'],
    ['catalog.listings.approve', 'catalog.listings.review', 'listing', 'delegated'],
    ['catalog.listings.reject', 'catalog.listings.review', 'listing', 'delegated'],
    ['catalog.listings.suspend', 'catalog.listings.suspend', 'listing', 'delegated'],
    ['catalog.listings.unsuspend', 'catalog.listings.suspend', 'listing', 'delegated'],
    ['catalog.listings.reveals.refund', 'catalog.listings.reveals.refund', 'listing_reveal', 'delegated'],
    ['catalog.listings.reveal_block', 'catalog.listings.reveal-block', 'listing', 'delegated'],
    ['catalog.listings.reveal_unblock', 'catalog.listings.reveal-block', 'listing', 'delegated'],
];
for (const [name, perm, target, transport] of EXPECTED_ACTIONS) {
    t.assert(`${name}: ${perm} · ${target} · ${transport}`, () => {
        const a = action(name);
        return a?.permission === perm && a.target === target && a.transport === transport;
    });
}
t.assert('both audit targets are platform_record (Support may read what was done to a listing)', () =>
    subjectClassOf('listing') === 'platform_record' && subjectClassOf('listing_reveal') === 'platform_record');

// ─── §4 ──────────────────────────────────────────────────────────────────────
t.section('§4 routes, permissions and audit declarations');

const routes = routeManifest().filter((r) => r.fullPath.startsWith('/api/v1/listings'));
const route = (method: string, path: string) =>
    routes.find((r) => r.method === method && r.fullPath === `/api/v1/listings${path}`);
const permsOf = (r: ReturnType<typeof route>) =>
    (r && r.access.kind === 'permission' ? [...r.access.permissions] : []);
const actionsOf = (r: ReturnType<typeof route>): string[] => {
    const a = r?.audit as { kind?: string; actions?: readonly string[] } | null | undefined;
    return a && a.kind === 'records' ? [...(a.actions ?? [])] : [];
};

const ROUTE_TABLE: Array<[string, string, string, string | null]> = [
    ['get', '', 'catalog.listings.read', null],
    ['get', '/:listingId', 'catalog.listings.read', null],
    ['get', '/:listingId/contacts', 'catalog.listings.contacts.read', 'catalog.listings.contacts.read'],
    ['post', '/:listingId/approve', 'catalog.listings.review', 'catalog.listings.approve'],
    ['post', '/:listingId/reject', 'catalog.listings.review', 'catalog.listings.reject'],
    ['post', '/:listingId/suspend', 'catalog.listings.suspend', 'catalog.listings.suspend'],
    ['post', '/:listingId/unsuspend', 'catalog.listings.suspend', 'catalog.listings.unsuspend'],
];
for (const [method, path, perm, audit] of ROUTE_TABLE) {
    const label = `${method.toUpperCase()} /api/v1/listings${path}`;
    t.assert(`${label} → ${perm}${audit ? ` · records ${audit}` : ' · unaudited read'}`, () => {
        const r = route(method, path) ?? (path === '' ? route(method, '/') : undefined);
        if (!r) return false;
        const p = permsOf(r);
        const a = actionsOf(r);
        return p.length === 1 && p[0] === perm && (audit === null ? r.audit === null : a.length === 1 && a[0] === audit);
    });
}
t.assert('every /api/v1/listings route is gated on catalog.listings.* permissions only', () =>
    routes.length >= ROUTE_TABLE.length
    && routes.every((r) => r.access.kind === 'permission' && r.access.permissions.every((p) => p.startsWith('catalog.listings.'))));
t.assert('the contacts route is the only audited READ on this mount', () =>
    routes.filter((r) => r.method === 'get' && r.audit !== null).map((r) => r.fullPath).join() === '/api/v1/listings/:listingId/contacts');
t.assert('the router is mounted once, at /listings', () => {
    const index = code(SRC, 'api/index.ts');
    return (index.match(/apiV1\.use\('\/listings',\s*listingRoutes\)/g) ?? []).length === 1;
});

// ─── §5 ──────────────────────────────────────────────────────────────────────
t.section('§5 ⛔ the contacts disclosure — audited BEFORE the read, fail-closed, no value on the record');

const DISCLOSURE = 'modules/listings/domain/listing-contacts-disclosure.ts';
const disclosure = code(SRC, DISCLOSURE);

t.assert('the intent commits through auditedAttempt, never best-effort', () =>
    disclosure.includes('auditedAttempt(intent')
    && !disclosure.includes('recordEvent')
    && !disclosure.includes('trackPending'));
t.assert('…the action is catalog.listings.contacts.read against a `listing` target', () =>
    disclosure.includes("action: 'catalog.listings.contacts.read'") && disclosure.includes("type: 'listing'"));
t.assert('⛔ listing_contacts is read INSIDE auditedAttempt, never before it', () => {
    const intentAt = disclosure.indexOf('auditedAttempt(intent');
    const readAt = disclosure.indexOf('contacts.findByListingId');
    return intentAt >= 0 && readAt > intentAt;
});
t.assert('the 404 read comes FIRST — a mistyped id is not an attempted disclosure', () => {
    const lookupAt = disclosure.indexOf('loadListingOr404(listingId)');
    return lookupAt >= 0 && lookupAt < disclosure.indexOf('auditedAttempt(intent');
});
t.assert('the audit payload names the listing and the vendor, and no contact', () => {
    const block = disclosure.slice(disclosure.indexOf('payload:'), disclosure.indexOf('return auditedAttempt'));
    return block.includes('listingId') && block.includes('vendorId') && !CONTACT_WORD.test(block)
        && !block.includes('found') && !block.includes('result');
});
t.assert('…and `after` carries the FIELD NAMES, never the mapped values', () =>
    disclosure.includes('after: { revealedFields: presentFieldsOf(result) }')
    && !/after:\s*\{\s*(result|found|contacts)\b/.test(disclosure));
t.assert('a contacts-read audit row is a platform_record and not delegated', () => {
    const row = toAuditRow(
        {
            action: 'catalog.listings.contacts.read',
            actor: { kind: 'administrator', id: OID, email: null, displayName: null, tier: 3, sessionId: null },
            target: { type: 'listing', id: OID2, label: 'Plumbing — Ets Kamga' },
            context: { method: 'GET', path: `/api/v1/listings/${OID2}/contacts`, requestId: 'r', ip: null, userAgent: null },
            payload: { listingId: OID2, vendorId: OID, status: 'pending_review', reviewState: 'pending_review' },
        },
        'succeeded',
        { after: { revealedFields: { published: [], pending: ['whatsapp', 'phone'] } } },
    );
    return row.subject_class === 'platform_record' && row.delegated === false && row.action_family === 'catalog'
        && !JSON.stringify(row).includes('+2376');
});
t.assert('presentFieldsOf names fields and carries no value', () => {
    const dto = toListingContactsDto(OID2, {
        _id: new ObjectId(OID), listing_id: new ObjectId(OID2), vendor_id: new ObjectId(OID),
        published: null,
        pending: { whatsapp: '+237670000031', phone: null, email: 'a@b.cm', website: null, socials: [], location: null, video: null },
    });
    const fields = presentFieldsOf(dto);
    return JSON.stringify(fields) === JSON.stringify({ published: [], pending: ['whatsapp', 'email'] })
        && !JSON.stringify(fields).includes('+237') && !JSON.stringify(fields).includes('a@b.cm');
});

// ─── §6 ──────────────────────────────────────────────────────────────────────
t.section('§6 ⛔ a contact reaches no surface but the contacts route');

const keysOf = (projection: Record<string, unknown>) => Object.keys(projection);
const PUBLIC_PROJECTIONS: Array<[string, Record<string, unknown>]> = [
    ['LISTING_LIST_PROJECTION', LISTING_LIST_PROJECTION],
    ['LISTING_DETAIL_PROJECTION', LISTING_DETAIL_PROJECTION],
    ['LISTING_VENDOR_PROJECTION', LISTING_VENDOR_PROJECTION],
    ['LISTING_FILE_PROJECTION', LISTING_FILE_PROJECTION],
];
for (const [name, projection] of PUBLIC_PROJECTIONS) {
    t.assert(`${name} names no contact field`, () => keysOf(projection).every((k) => !CONTACT_WORD.test(k)));
}
t.assert('⛔ the vendor projection is NOT the directory\'s — no email, no phone', () =>
    !('email' in LISTING_VENDOR_PROJECTION) && !('phone' in LISTING_VENDOR_PROJECTION));
t.assert('the search matches public names only', () => LISTING_SEARCH_FIELDS.every((f) => !CONTACT_WORD.test(f)));
t.assert('the contacts projection is the one that DOES name them (the scan above is not vacuous)', () =>
    LISTING_CONTACT_FIELDS.every((f) => keysOf(LISTING_CONTACT_PROJECTION).some((k) => k.startsWith(`pending.${f}`)))
    && LISTING_CONTACT_FIELDS.every((f) => keysOf(LISTING_CONTACT_PROJECTION).some((k) => k.startsWith(`published.${f}`))));

/**
 * The inline projections too — a `super(COLLECTIONS.X, { … })` or a `projection: { … }` option
 * written straight into a repository would escape the export-based check above.
 */
const CONTACT_REPO = 'modules/listings/repositories/listing-contact.read.repository.ts';
const moduleFiles = walk(MOD).map(rel);
t.assert('no inline projection in the module (outside the contacts repository) names a contact field', () =>
    moduleFiles.filter((f) => f !== CONTACT_REPO).every((f) => {
        const src = code(SRC, f);
        const blocks = [
            ...Array.from(src.matchAll(/super\(COLLECTIONS\.\w+,\s*(\{[^}]*\})/g)).map((m) => m[1]),
            ...Array.from(src.matchAll(/projection:\s*(\{[^}]*\})/g)).map((m) => m[1]),
            ...Array.from(src.matchAll(/PROJECTION\s*=\s*\{([\s\S]*?)\}\s*as const/g)).map((m) => m[1]),
        ];
        return blocks.every((b) => !CONTACT_WORD.test(b));
    }));

const allSrc = walk(SRC).map(rel);
/** The access table declares the collection; that is a registration, not a reader. */
const ACCESS_TABLE = 'infra/platform/platform-collections.ts';
t.assert('⛔ COLLECTIONS.LISTING_CONTACT is named by exactly one reader — the contacts repository', () => {
    const naming = allSrc.filter((f) => f !== ACCESS_TABLE && /COLLECTIONS\.LISTING_CONTACT\b/.test(code(SRC, f)));
    return naming.length === 1 && naming[0] === CONTACT_REPO;
});
t.assert('…and no file reaches `listing_contacts` by its literal name either', () =>
    allSrc.filter((f) => f !== 'infra/platform/collections.ts')
        .every((f) => !/['"`]listing_contacts['"`]/.test(code(SRC, f))));
t.assert('⛔ the contacts repository is instantiated only by the disclosure', () => {
    const using = allSrc.filter((f) => /new ListingContactReadRepository\b/.test(code(SRC, f)));
    return using.length === 1 && using[0] === DISCLOSURE;
});
t.assert('…and nothing else imports its value (type-only imports for the DTO are allowed)', () =>
    allSrc.filter((f) => f !== DISCLOSURE).every((f) =>
        !/import\s*\{[^}]*\bListingContactReadRepository\b[^}]*\}\s*from/.test(code(SRC, f))));
t.assert('the disclosure is called from one place — the contacts handler', () => {
    const using = allSrc.filter((f) => f !== DISCLOSURE && /revealContacts\(/.test(code(SRC, f)));
    return using.length === 1 && using[0] === 'modules/listings/controllers/listing.controller.ts';
});

/** A row stuffed with contact-shaped values, as if a projection had widened: the DTOs drop them. */
const LEAKY = {
    _id: new ObjectId(OID2),
    vendor_id: new ObjectId(OID),
    slug: 'plombier-akwa',
    status: 'live',
    whatsapp: '+237699000031',
    suspension: null,
    published: {
        title: 'Plombier', company_name: 'Ets Kamga', category_ids: [new ObjectId(OID)], country: 'CM',
        city: 'Douala', area: 'Akwa', description: 'Fuites et installations', description_rich: null,
        photo_file_ids: [], opening_hours: null, phone: '+237699000031', email: 'kamga@leak.cm',
    },
    pending: null,
    review: null,
    last_decision: null,
    available_fields: ['whatsapp', 'phone'],
    published_at: new Date('2026-10-19T10:00:00.000Z'),
    archived_at: null,
    vectorisation_status: 'completed',
    created_at: new Date('2026-10-18T10:00:00.000Z'),
    updated_at: new Date('2026-10-19T10:00:00.000Z'),
} as unknown as ListingReadModel;
const LEAKY_VENDOR = { _id: new ObjectId(OID), display_name: 'Jean Kamga', status: 'active', kind: 'provider', email: 'v@leak.cm', phone: '+237677000099' };
const ctx = { vendor: LEAKY_VENDOR as never, categories: new Map(), files: new Map(), counts: { leads: 3, reveals: 5 } };

t.assert('the queue row forwards no contact value, whatever the row carries', () => {
    const out = JSON.stringify(toListingQueueItemDto(LEAKY, LEAKY_VENDOR as never));
    return !out.includes('+23769') && !out.includes('+23767') && !out.includes('leak.cm');
});
t.assert('the detail forwards no contact value either — field NAMES only', () => {
    const out = JSON.stringify(toListingDetailDto(LEAKY, ctx));
    return !out.includes('+23769') && !out.includes('+23767') && !out.includes('leak.cm')
        && out.includes('"availableFields":["whatsapp","phone"]');
});

// ─── §7 ──────────────────────────────────────────────────────────────────────
t.section('§7 the gateway — § C-3 paths and bodies, exactly');

const gw = code(SRC, 'modules/listings/gateways/listing.gateway.ts');
t.assert('approve → POST /listings/:id/approve with `{}`', () =>
    gw.includes('call(`/listings/${target.listingId}/approve`, {}, context)'));
t.assert('reject → POST /listings/:id/reject with `{ reasons }`', () =>
    gw.includes('call(`/listings/${target.listingId}/reject`, { reasons }, context)'));
t.assert('suspend → POST /listings/:id/suspend with `{ note }`', () =>
    gw.includes('call(`/listings/${target.listingId}/suspend`, { note }, context)'));
t.assert('unsuspend → POST /listings/:id/unsuspend with `{ note }` or `{}`', () =>
    gw.includes('const body = note ? { note } : {};')
    && gw.includes('call(`/listings/${target.listingId}/unsuspend`, body, context)'));
t.assert('every delegated call is a POST through platformRequest (never retried — GET only)', () =>
    gw.includes("method: 'POST'") && !/method:\s*'(GET|PUT|PATCH|DELETE)'/.test(gw) && gw.includes('platformRequest<'));
t.assert('each verb is audited under its own action, intent before the call', () =>
    ['approve', 'reject', 'suspend', 'unsuspend'].every((v) => gw.includes(`auditedDelegation('catalog.listings.${v}'`))
    && gw.includes('return auditedAttempt('));
t.assert('wi-admin never writes a listing collection itself', () =>
    moduleFiles.filter((f) => f.includes('/repositories/')).every((f) =>
        !/insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|replaceOne|bulkWrite/.test(code(SRC, f))));
t.assert('the repositories never import the delegation client, and the gateway never imports a repository base', () =>
    moduleFiles.filter((f) => f.includes('/repositories/')).every((f) => !code(SRC, f).includes('platform.client'))
    && !gw.includes('platform.repository'));
// Against jovi-mall's validators, which CI checks out beside this repo, rather than the plan:
// the plan lives in the workspace repo, which no CI job has (it failed ENOENT on 2026-11-08), and the
// validator is what actually refuses a body this gateway sends.
t.assert('jovi-mall still accepts the four bodies this gateway sends (approve {}, reject reasons, suspend note, unsuspend note?)', () => {
    const v = code(JOVI, 'modules/listings/validators/listing.validator.ts');
    return /AdminApproveSchema = z\.object\(\{\}\)\.strict\(\)/.test(v)
        && /AdminRejectSchema = z\.object\(\{\s*reasons: z\.array\(z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\)\)\.min\(1\)\.max\(5\)/.test(v)
        && /AdminSuspendSchema = z\.object\(\{\s*note: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\),/.test(v)
        && /AdminUnsuspendSchema = z\.object\(\{\s*note: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\)\.optional\(\)/.test(v);
});

// ─── §8 ──────────────────────────────────────────────────────────────────────
t.section('§8 request shapes');

t.assert('the list query is LENIENT — built on listQuery, it strips an unknown key (house rule, test:list-strictness)', () => {
    const r = ListListingsQuerySchema.safeParse({ __definitely_not_a_parameter__: '1' });
    return r.success && !('__definitely_not_a_parameter__' in r.data);
});
t.assert('…and still refuses a bad VALUE (reviewState, status, vendorId)', () =>
    !ListListingsQuerySchema.safeParse({ reviewState: 'approved' }).success
    && !ListListingsQuerySchema.safeParse({ status: 'deleted' }).success
    && !ListListingsQuerySchema.safeParse({ vendorId: 'nope' }).success);
t.assert('default order is the oldest submission first', () => {
    const r = ListListingsQuerySchema.parse({});
    return r.sort.field === 'submittedAt' && r.sort.direction === 1 && r.page === 1 && r.limit === 20;
});
t.assert('a contact path is not a sortable field', () =>
    !ListListingsQuerySchema.safeParse({ sort: 'pending.whatsapp' }).success);
t.assert('the submission range is half-open and ordered', () =>
    !ListListingsQuerySchema.safeParse({ from: '2026-10-19T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' }).success
    && ListListingsQuerySchema.safeParse({ from: '2026-10-18T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z' }).success);
t.assert('the filter builds each clause, and nothing when nothing is asked', () => {
    const none = JSON.stringify(buildListingFilter({}));
    const all = buildListingFilter({
        reviewState: 'pending_review', status: 'live', vendorId: OID,
        from: new Date('2026-10-18T00:00:00.000Z'), to: new Date('2026-10-19T00:00:00.000Z'), search: 'plomb',
    }) as { $and: Array<Record<string, unknown>> };
    const range = all.$and.find((c) => 'review.submitted_at' in c)?.['review.submitted_at'] as Record<string, Date>;
    return none === '{}' && all.$and.length === 5
        && all.$and.some((c) => c['review.state'] === 'pending_review')
        && all.$and.some((c) => c.status === 'live')
        && all.$and.some((c) => String(c.vendor_id) === OID)
        && range.$gte instanceof Date && range.$lt instanceof Date && !('$lte' in range);
});
t.assert('the search term is escaped — a regex metacharacter is literal', () => {
    const f = buildListingFilter({ search: 'a.b' }) as { $and: Array<{ $or: Array<Record<string, RegExp>> }> };
    const pattern = f.$and[0].$or[0]['published.title'];
    return pattern.test('a.b') && !pattern.test('axb') && f.$and[0].$or.length === LISTING_SEARCH_FIELDS.length;
});
t.assert('approve takes `{}` and nothing else', () =>
    ApproveListingSchema.safeParse({}).success && !ApproveListingSchema.safeParse({ force: true }).success);
t.assert('reject: 1–5 reasons, each 3–500, strict', () =>
    RejectListingSchema.safeParse({ reasons: ['Phone number in photo 3'] }).success
    && !RejectListingSchema.safeParse({ reasons: [] }).success
    && !RejectListingSchema.safeParse({ reasons: ['ab'] }).success
    && !RejectListingSchema.safeParse({ reasons: ['x'.repeat(501)] }).success
    && !RejectListingSchema.safeParse({ reasons: ['one', 'two', 'three', 'four', 'five', 'six'] }).success
    && !RejectListingSchema.safeParse({ reasons: ['A fine reason'], note: 'x' }).success);
t.assert('suspend: note required, 3–500, strict', () =>
    SuspendListingSchema.safeParse({ note: 'Misleading photos' }).success
    && !SuspendListingSchema.safeParse({}).success
    && !SuspendListingSchema.safeParse({ note: 'ab' }).success
    && !SuspendListingSchema.safeParse({ note: 'Misleading', reason: 'x' }).success);
t.assert('unsuspend: note optional, still bounded, strict', () =>
    UnsuspendListingSchema.safeParse({}).success
    && UnsuspendListingSchema.safeParse({ note: 'Fixed by provider' }).success
    && !UnsuspendListingSchema.safeParse({ note: 'ab' }).success
    && !UnsuspendListingSchema.safeParse({ force: true }).success);

// ─── §9 ──────────────────────────────────────────────────────────────────────
t.section('§9 wire shapes — exact keys, absent = null');

const sortedKeys = (o: object) => Object.keys(o).sort().join(',');
const EMPTY = {
    _id: new ObjectId(OID2), vendor_id: new ObjectId(OID), slug: 's', status: 'draft',
    created_at: new Date('2026-10-18T10:00:00.000Z'), updated_at: new Date('2026-10-18T10:00:00.000Z'),
} as unknown as ListingReadModel;

t.assert('queue row key set', () =>
    sortedKeys(toListingQueueItemDto(EMPTY, undefined)) === [
        'id', 'slug', 'status', 'reviewState', 'isRevision', 'title', 'companyName', 'city', 'submittedAt',
        'preflagCount', 'suspensionReason', 'vendor', 'publishedAt', 'createdAt', 'updatedAt',
    ].sort().join(','));
t.assert('a sparse row answers null, never an omitted key', () => {
    const dto = toListingQueueItemDto(EMPTY, undefined) as unknown as Record<string, unknown>;
    return Object.values(dto).every((v) => v !== undefined)
        && dto.title === null && dto.reviewState === null && dto.submittedAt === null && dto.preflagCount === 0
        && JSON.stringify(dto.vendor) === JSON.stringify({ id: OID, displayName: null });
});
t.assert('the queue row describes the copy UNDER REVIEW on a revision', () => {
    const dto = toListingQueueItemDto({
        ...LEAKY,
        pending: { title: 'Plombier agréé', company_name: 'Ets Kamga & Fils', city: 'Douala' },
        review: { state: 'pending_review', submitted_at: new Date('2026-10-19T11:00:00.000Z'), preflags: [{ kind: 'phone' }, { kind: 'url' }] },
    } as unknown as ListingReadModel, undefined);
    return dto.title === 'Plombier agréé' && dto.isRevision === true && dto.preflagCount === 2
        && dto.submittedAt === '2026-10-19T11:00:00.000Z';
});
t.assert('detail key set', () =>
    sortedKeys(toListingDetailDto(EMPTY, { ...ctx, vendor: undefined })) === [
        'id', 'slug', 'status', 'vendor', 'published', 'pending', 'isRevision', 'review', 'lastDecision',
        'suspension', 'availableFields', 'counts', 'availableActions', 'vectorisationStatus', 'publishedAt',
        'archivedAt', 'createdAt', 'updatedAt',
    ].sort().join(','));
t.assert('detail content and vendor key sets; a missing category keeps its id with a null name', () => {
    const dto = toListingDetailDto(LEAKY, ctx);
    return dto.published !== null
        && sortedKeys(dto.published) === ['title', 'companyName', 'categories', 'country', 'city', 'area',
            'description', 'descriptionRich', 'photos', 'openingHours'].sort().join(',')
        && sortedKeys(dto.vendor) === ['id', 'displayName', 'status', 'kind', 'kycStatus', 'verified'].sort().join(',')
        && dto.vendor.kind === 'provider' && dto.vendor.kycStatus === 'pending' && dto.vendor.verified === false
        && JSON.stringify(dto.published.categories) === JSON.stringify([{ id: OID, name: null, slug: null }])
        && dto.counts.leads === 3 && dto.counts.reveals === 5 && dto.pending === null;
});
t.assert('a vendor with no `kind` is a seller (§ C-1: no backfill)', () =>
    vendorKindOf({}) === 'seller' && vendorKindOf(undefined) === 'seller' && vendorKindOf({ kind: 'provider' }) === 'provider');
t.assert('contacts DTO: both copies, exact key sets, coordinates un-swapped', () => {
    const dto = toListingContactsDto(OID2, {
        _id: new ObjectId(OID), listing_id: new ObjectId(OID2), vendor_id: new ObjectId(OID),
        published: {
            whatsapp: '+237670000031', phone: null, email: null, website: null, socials: [{ network: 'facebook', url: 'https://fb.com/x' }],
            location: { formatted_address: 'Rue Joss, Akwa', coordinates: { type: 'Point', coordinates: [9.7, 4.05] }, components: { city: 'Douala' } },
            video: { url: 'https://youtu.be/x', host: 'youtube', checked_at: new Date('2026-10-19T09:00:00.000Z') },
        },
        pending: null,
    });
    const set = dto.published!;
    return sortedKeys(dto) === 'listingId,pending,published'
        // `phone2` (2026-11-08) is a second VALUE of the `phone` field, not an eighth field.
        && sortedKeys(set) === [...LISTING_CONTACT_FIELDS, 'phone2'].sort().join(',')
        && set.phone2 === null
        && set.location?.latitude === 4.05 && set.location.longitude === 9.7
        && set.location.components.countryCode === null
        && set.video?.checkedAt === '2026-10-19T09:00:00.000Z' && dto.pending === null;
});
t.assert('a listing with no contacts row answers two null copies, not an error', () =>
    JSON.stringify(toListingContactsDto(OID2, null)) === JSON.stringify({ listingId: OID2, published: null, pending: null }));
t.assert('available actions follow the state: review → approve/reject; live → suspend; oversight → unsuspend only', () =>
    availableActionsOf({ status: 'pending_review', review: { state: 'pending_review' } } as never).join() === 'approve,reject'
    && availableActionsOf({ status: 'live', review: { state: 'pending_review' } } as never).join() === 'approve,reject,suspend'
    && availableActionsOf({ status: 'suspended', suspension: { reason: 'platform_oversight' } } as never).join() === 'unsuspend'
    && availableActionsOf({ status: 'suspended', suspension: { reason: 'insufficient_credits' } } as never).join() === ''
    && availableActionsOf({ status: 'draft', review: { state: 'editing' } } as never).join() === '');

process.exit(t.finish());

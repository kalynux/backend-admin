/**
 * Shipment management — the rules, with no infrastructure.
 *
 * **§1 is the most valuable test in this phase.** The collections this module reads hold a
 * customer's COD delivery code and a delivery agent's GPS position, and one of those is
 * protected by NOTHING except the projection whitelist: jovi-mall marks
 * `cash_collections.code_plain` `select: false`, and this service reads with the raw
 * MongoDB driver, which does not honour Mongoose `select`. So §1 scans the whole module for
 * every banned field name AND for the whole-subdocument forms that would drag them back in.
 *
 * The other sections that carry weight:
 *
 *   §2  the filter composes under `$and` — the search is `$or`-shaped, and merging by
 *       assignment answers a different question than the one asked.
 *   §3  the tracking-number search is ANCHORED and uppercased, so the partial unique index
 *       serves it. That is why no search index was added.
 *   §5  the two cross-repo guards, which catch a "simplification" of this phase's own work
 *       in the OTHER repository: `applyRejection` keeping its compare-and-set, and the
 *       offer schema's `created_by.role` enum keeping `admin`. Without the second, an admin
 *       reassign throws a ValidationError AFTER the old agent has been detached.
 *
 *   npm run test:shipments
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { suite, throws } from './_assert';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import {
    CancelShipmentSchema,
    ListShipmentActivityQuerySchema,
    ReassignShipmentSchema,
    SHIPMENT_AUDIT_ACTIONS,
    SHIPMENT_SORT,
    SearchShipmentsQuerySchema,
    TrackingEventsQuerySchema,
    TrackingTrailQuerySchema,
} from '../../src/modules/shipments/validators/shipment.validator';
import { buildFilter } from '../../src/modules/shipments/repositories/shipment.read.repository';
import { AUDIT_CATALOG } from '../../src/modules/audit/domain/audit.catalog';
import { PERMISSION_CATALOG } from '../../src/modules/authorization/domain/permission.catalog';
import { PLATFORM_COLLECTIONS } from '../../src/infra/platform/platform-collections';
import { routeManifest } from '../../src/api/route-manifest';
import '../../src/modules/shipments/routes/shipment.routes';

const t = suite('shipment management');

const MODULE = join(__dirname, '..', '..', 'src', 'modules', 'shipments');
const JOVI = join(__dirname, '..', '..', '..', 'jovi-mall', 'src');

function readCode(dir: string): { file: string; code: string }[] {
    const out: { file: string; code: string }[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...readCode(full));
            continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const raw = readFileSync(full, 'utf8');
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        out.push({ file: full, code });
    }
    return out;
}

const parse = (query: Record<string, unknown>) => SearchShipmentsQuerySchema.parse({ ...query });

type AuditSpec = { permission: string | null; target: string; transport: string };
const auditCatalog = AUDIT_CATALOG as unknown as Record<string, AuditSpec>;

type PermissionSpec = { destructive?: boolean; financial?: boolean };
const permissions = PERMISSION_CATALOG as unknown as Record<string, PermissionSpec>;

type CollectionSpec = { access: string; writes: string };
const collections = PLATFORM_COLLECTIONS as unknown as Record<string, CollectionSpec>;

const files = readCode(MODULE);

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. NOTHING SENSITIVE LEAVES — the section this module exists to protect');

t.assert('the module has files to scan', () => files.length >= 6);

/**
 * The delivery code is a bearer credential over the customer's cash: submitting it is the
 * ONLY API path by which a COD shipment reaches `delivered`. Mongoose's `select: false`
 * does not reach the raw driver, so these two lines are the whole defence.
 */
for (const needle of ['code_plain', 'code_hash']) {
    t.assert(`NO file in the module names ${needle}`, () => files.every((f) => !f.code.includes(needle)));
}

/** An agent's GPS fix, IP and device at handoff — telemetry, not administration. */
for (const needle of ['verification.location', 'verification.ip', 'verification.device_info']) {
    t.assert(`no file names ${needle}`, () => files.every((f) => !f.code.includes(needle)));
}

/**
 * `handover.pickup.location` is very often a delivery agent's last known GPS position
 * (`source: 'previous_agent_location'`). `.geo` is the same value in GeoAddress clothing.
 */
for (const needle of ['handover.pickup.location', 'handover.pickup.geo', 'pickup.location']) {
    t.assert(`no file names ${needle}`, () => files.every((f) => !f.code.includes(needle)));
}

/** Every agent considered, each with a trust score. The offer rows already tell the story. */
t.assert('no file names candidate_pool', () => files.every((f) => !f.code.includes('candidate_pool')));

/**
 * The whole-subdocument forms. This is the assertion that actually holds the line: each of
 * these would silently restore several of the fields banned above.
 */
t.assert(
    'no projection uses the whole-subdocument form `handover: 1`',
    () => files.every((f) => !/\bhandover:\s*1/.test(f.code)),
);
t.assert(
    "no projection uses `'handover.pickup': 1`",
    () => files.every((f) => !/'handover\.pickup':\s*1/.test(f.code)),
);
t.assert(
    'no projection uses `verification: 1`',
    () => files.every((f) => !/\bverification:\s*1/.test(f.code)),
);
t.assert(
    'no projection uses `cash_collection: 1`',
    () => files.every((f) => !/\bcash_collection:\s*1/.test(f.code)),
);

const codRepo = files.find((f) => f.file.endsWith('shipment-context.read.repository.ts'))!;
t.assert(
    'the COD projection names verification.method — the fact a dispute turns on',
    () => codRepo.code.includes("'verification.method': 1"),
);
const shipmentRepo = files.find((f) => f.file.endsWith('shipment.read.repository.ts'))!;
t.assert(
    'the handover is projected DOTTED, field by field',
    () => shipmentRepo.code.includes("'handover.pickup.source': 1"),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. The filter and the query schema');

t.assert('defaults to newest first', () => parse({}).sort.field === 'createdAt');
t.assert('an unindexed field is not sortable', () => throws(() => parse({ sort: 'updatedAt' })));
t.assert(
    'status is a BOUNDED STRING — the enum is a cross-service contract with geo-tracker',
    () => parse({ status: 'some_future_status' }).status === 'some_future_status',
);
t.assert(
    'handing_over passes — a status jovi-mall added after the contract was written',
    () => parse({ status: 'handing_over' }).status === 'handing_over',
);
t.assert('agentId must be an ObjectId', () => throws(() => parse({ agentId: 'nope' })));

t.assert('an empty query is an empty filter', () => Object.keys(buildFilter(parse({}))).length === 0);
t.assert(
    'one clause is returned bare, not wrapped',
    () => !('$and' in buildFilter(parse({ status: 'assigned' }))),
);
t.assert('every filter contributes its own clause', () => {
    const everything = buildFilter(parse({
        status: 'assigned',
        agencyId: '507f1f77bcf86cd799439011',
        agentId: '507f1f77bcf86cd799439012',
        orderId: '507f1f77bcf86cd799439013',
        assignmentState: 'offered',
        unassigned: 'false',
        held: 'false',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        search: 'ACR-260101',
    })) as { $and: unknown[] };
    return everything.$and.length === 9;
});
t.assert('the search clause is $or-shaped', () => {
    const filter = buildFilter(parse({ search: 'ACR-260101' })) as Record<string, unknown>;
    return '$or' in filter;
});
t.assert(
    'unassigned=true means agent_id is null',
    () => JSON.stringify(buildFilter(parse({ unassigned: 'true' }))).includes('$eq'),
);
t.assert(
    'a term matching nothing returns nothing, not everything',
    () => JSON.stringify(buildFilter(parse({ search: '111111111111111111111111' }))).includes('$or'),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. The search uses the index it was designed for');

t.assert(
    'the tracking-number branch is ANCHORED and uppercased',
    () => shipmentRepo.code.includes("new RegExp('^' + escapeRegex(term.toUpperCase()))"),
);
t.assert(
    'containsInsensitive is never applied to the shipment filter',
    () => !shipmentRepo.code.includes('containsInsensitive'),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. Every sortable field is index-backed in jovi-mall');

const shipmentModel = readFileSync(join(JOVI, 'modules', 'shipments', 'shipment.model.ts'), 'utf8');

t.assert(
    'jovi-mall declares {created_at: -1}',
    () => shipmentModel.includes('ShipmentSchema.index({ created_at: -1 })'),
);
t.assert(
    'jovi-mall declares the status compound',
    () => shipmentModel.includes('ShipmentSchema.index({ status: 1, created_at: -1 })'),
);
t.assert(
    'jovi-mall declares the agency compound',
    () => shipmentModel.includes('ShipmentSchema.index({ agency_id: 1, created_at: -1 })'),
);
t.assert(
    'jovi-mall declares the agent compound',
    () => shipmentModel.includes('ShipmentSchema.index({ agent_id: 1, created_at: -1 })'),
);
t.assert(
    'SHIPMENT_SORT maps only createdAt',
    () => Object.keys(SHIPMENT_SORT).length === 1 && SHIPMENT_SORT.createdAt === 'created_at',
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. jovi-mall keeps the guards this phase added — the cross-repo scan');

const shipmentRepoJovi = readFileSync(join(JOVI, 'modules', 'shipments', 'shipment.repository.ts'), 'utf8');
const offerModel = readFileSync(
    join(JOVI, 'modules', 'shipment-assignment', 'models', 'shipment-assignment-offer.model.ts'), 'utf8',
);
const assignmentService = readFileSync(
    join(JOVI, 'modules', 'shipment-assignment', 'domain', 'services', 'shipment-assignment.service.ts'), 'utf8',
);
const shipmentService = readFileSync(join(JOVI, 'modules', 'shipments', 'shipment.service.ts'), 'utf8');

// F-2 — without this, two concurrent rejects both win and both fire post-commit effects.
t.assert(
    'applyRejection is a COMPARE-AND-SET, not a blind findByIdAndUpdate',
    () => /applyRejection[\s\S]{0,1400}findOneAndUpdate\(\s*\{[^}]*status:\s*'assigned'/.test(shipmentRepoJovi),
);
t.assert(
    '...and it pins the owning agency too',
    () => /applyRejection[\s\S]{0,1400}agency_id:\s*agencyId/.test(shipmentRepoJovi),
);
t.assert(
    'a missed rejection CAS raises a conflict rather than clobbering',
    () => shipmentService.includes('SHIPMENT_STATUS_CONFLICT'),
);

// F-1 — without this, an admin reassign throws AFTER the old agent has been detached.
t.assert(
    "the offer schema's created_by.role enum accepts 'admin'",
    () => offerModel.includes("enum: ['agency', 'system', 'admin']"),
);
t.assert(
    "OfferCreator.role accepts 'admin'",
    () => assignmentService.includes("role: 'agency' | 'system' | 'admin'"),
);
t.assert(
    'the offer carries a name snapshot — an admin id resolves in no jovi-mall collection',
    () => offerModel.includes('name: { type: String, default: null, trim: true, maxlength: 200 }'),
);

// A-6 — the rejection actor stamp.
t.assert(
    'the rejection carries an actor source, so an admin id is legible rather than dangling',
    () => shipmentModel.includes('rejectedBySource'),
);
t.assert('...and a name snapshot', () => shipmentModel.includes('rejectedByName'));
t.assert(
    'platform_intervention exists as a reason an administrator owns',
    () => shipmentModel.includes("'platform_intervention'"),
);
t.assert(
    'the reason vocabulary is spread from one array, not retyped per site',
    () => shipmentModel.includes('SHIPMENT_REJECTION_REASONS')
        && shipmentModel.includes('enum: SHIPMENT_REJECTION_REASONS'),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The audit catalog wiring');

for (const action of ['shipments.reassign', 'shipments.cancel']) {
    t.assert(`${action} is in the catalog`, () => auditCatalog[action] !== undefined);
    t.assert(`${action} targets a shipment`, () => auditCatalog[action]?.target === 'shipment');
    t.assert(`${action} is delegated`, () => auditCatalog[action]?.transport === 'delegated');
    t.assert(
        `${action}'s permission is in the shipments family`,
        () => (auditCatalog[action]?.permission ?? '').startsWith('shipments.'),
    );
}

t.assert(
    'there is NO admin status-transition action — driving the lifecycle is not administrative',
    () => Object.keys(auditCatalog).every((name) => !name.startsWith('shipments.status')),
);
/**
 * Two at Phase 6 (`reassign`, `cancel`), three since Phase 6.I added the audited GPS-trail
 * read. Derived from the catalog rather than typed out, which is why adding the third
 * action widened the filter with no edit here — the count is what pins that it is derived.
 */
t.assert(
    'the activity filter is derived from the catalog',
    () => SHIPMENT_AUDIT_ACTIONS.length === 3
        && SHIPMENT_AUDIT_ACTIONS.includes('shipments.tracking.trail.read'),
);
t.assert(
    'the activity feed refuses an action from another family',
    () => throws(() => ListShipmentActivityQuerySchema.parse({ action: 'orders.cancel' })),
);

t.assert('shipments.cancel is destructive', () => permissions['shipments.cancel'].destructive === true);
t.assert(
    'shipments.reassign is NOT destructive — the shipment survives, only the agent changes',
    () => permissions['shipments.reassign'].destructive !== true,
);
t.assert('shipments.read is neither', () => permissions['shipments.read'].destructive !== true);

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. Routes');

const routes = routeManifest().filter((route) => route.fullPath.startsWith('/api/v1/shipments'));

/** Six at Phase 6, plus the two geo-tracker data reads at Phase 6.I (ADR-020). */
t.assert('eight shipment routes are registered', () => routes.length === 8);

/**
 * The scope model, asserted where it is actually enforced.
 *
 * A delivery's trail is reachable only by naming a SHIPMENT — geo-tracker has no route
 * that takes an agent id and answers with a trail — and these two routes are this
 * service's half of that bound. They hold `shipments.tracking.read`, in the shipments
 * family, NOT the agents-family permission that governs the live-position read: live
 * surveillance of a person and a case file about a delivery are different exposures, and
 * an operator can grant them apart.
 */
t.assert('the two tracking reads are declared, and both are GETs', () => {
    const trail = routes.find((r) => r.fullPath.endsWith('/tracking-trail'));
    const events = routes.find((r) => r.fullPath.endsWith('/tracking-events'));
    return trail?.method === 'get' && events?.method === 'get'
        && JSON.stringify(trail.access).includes('shipments.tracking.read')
        && JSON.stringify(events.access).includes('shipments.tracking.read');
});

/**
 * ⚠ The audited READ. Every point on this trail is where a person actually was, so the
 * audit row commits BEFORE the disclosure and its failure is not caught. Nothing at boot
 * requires an audit declaration on a `get`, so this assertion is the only thing standing
 * between an audited disclosure and a read like any other.
 */
t.assert('the trail read is audited and the events read is not', () => {
    const trail = routes.find((r) => r.fullPath.endsWith('/tracking-trail'));
    const events = routes.find((r) => r.fullPath.endsWith('/tracking-events'));
    return trail?.audit?.kind === 'records'
        && trail.audit.actions.includes('shipments.tracking.trail.read')
        && !events?.audit;
});

/** The purpose axis: a trail disclosure must say why, and geo-tracker refuses one without. */
t.assert('the trail read requires a reason; the events read takes none', () =>
    TrackingTrailQuerySchema.safeParse({ reason: 'dispute 114' }).success
    && !TrackingTrailQuerySchema.safeParse({}).success
    && !TrackingTrailQuerySchema.safeParse({ reason: ' ' }).success
    && !TrackingTrailQuerySchema.safeParse({ reason: 'dispute 114', limit: 50_000 }).success
    && TrackingEventsQuerySchema.safeParse({}).success
    && !TrackingEventsQuerySchema.safeParse({ reason: 'why' }).success);
t.assert('every one carries an access declaration', () => routes.every((route) => route.access !== undefined));
t.assert(
    'none is public',
    () => routes.every((route) => !JSON.stringify(route.access).includes('"public"')),
);
t.assert(
    'there is no status-transition route',
    () => routes.every((route) => !route.fullPath.endsWith('/status')),
);
t.assert(
    'the offer trail additionally requires agents.read — it names agents',
    () => JSON.stringify(routes.find((r) => r.fullPath.endsWith('/offers'))?.access).includes('agents.read'),
);
t.assert(
    'the activity feed additionally requires audit.read',
    () => JSON.stringify(routes.find((r) => r.fullPath.endsWith('/activity'))?.access).includes('audit.read'),
);
t.assert(
    'no route is registered directly on the router',
    () => readCode(join(MODULE, 'routes')).every((f) => !/router\.(get|post|patch|put|delete)\(/.test(f.code)),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('8. Write bodies');

t.assert('a reassign reason is required', () => throws(() => ReassignShipmentSchema.parse({})));
t.assert(
    'agentId is OPTIONAL — omitted pre-pickup means auto-assign, and the rule is jovi-mall’s',
    () => ReassignShipmentSchema.parse({ reason: 'agent unreachable' }).agentId === undefined,
);
t.assert(
    'a malformed agentId is refused',
    () => throws(() => ReassignShipmentSchema.parse({ reason: 'a reason', agentId: 'nope' })),
);
t.assert(
    'an unknown key is refused',
    () => throws(() => ReassignShipmentSchema.parse({ reason: 'a reason', extra: 1 })),
);

t.assert('a cancel note is REQUIRED — the vendor has to be tellable why', () => throws(
    () => CancelShipmentSchema.parse({}),
));
t.assert(
    'the cancel reason defaults to the one an administrator owns',
    () => CancelShipmentSchema.parse({ note: 'pulled by the platform' }).reason === 'platform_intervention',
);
t.assert(
    'a note over 200 characters is refused — jovi-mall stores it in a bounded field',
    () => throws(() => CancelShipmentSchema.parse({ note: 'x'.repeat(201) })),
);

// ─────────────────────────────────────────────────────────────────────────────
t.section('9. Data access');

for (const name of ['shipments', 'shipment_assignment_offers', 'cash_collections', 'tracking_outbox']) {
    t.assert(`${name} is declared`, () => collections[name] !== undefined);
    t.assert(`${name} is read-only here`, () => collections[name]?.access === 'read');
}

t.assert(
    'shipment_assignment_sessions is deliberately NOT read — a transient ranking',
    () => collections['shipment_assignment_sessions'] === undefined,
);
t.assert(
    'every gateway write goes through platformRequest',
    () => readCode(join(MODULE, 'gateways')).every((f) => f.code.includes('platformRequest')),
);
t.assert(
    'the audit wrapper lives in the gateway, not the controller',
    () => readCode(join(MODULE, 'gateways')).some((f) => f.code.includes('auditedAttempt')),
);
t.assert(
    'the controller never calls auditedAttempt directly',
    () => readCode(join(MODULE, 'controllers')).every((f) => !f.code.includes('auditedAttempt')),
);
t.assert(
    'trackability is NOT recomputed here — jovi-mall owns that policy',
    () => files.every((f) => !f.code.includes('TRACKABLE_SHIPMENT_STATUSES')),
);

process.exit(t.finish());

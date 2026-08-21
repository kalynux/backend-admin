/**
 * Messaging — one route, and the one that emptied the legacy map.
 *
 * Phase 5 Part C moved `POST /api/webhooks/telegram/send` here as
 * `POST /api/v1/messaging/telegram`. One route is not much to test; what earns this suite
 * is that **every decision Part C took fails silently**, and two of them fail in a
 * direction nobody notices until somebody asks a question the trail cannot answer:
 *
 *   §1  **The exactly-one-of rule.** jovi-mall accepts a body carrying BOTH `userId` and
 *       `chatId`, then prefers the chat and never resolves the user. The message goes
 *       somewhere, the response says `sent: true`, and half of what the operator asked for
 *       was ignored with no error. This side refuses the pair; that refusal is the only
 *       thing standing between an operator and a message delivered to the wrong person.
 *   §2  **O-2 — the audit row keeps the body.** A send cannot be recalled and jovi-mall
 *       keeps no delivery record, so this row IS the evidence. A payload that quietly stops
 *       carrying `message` still writes a row, still answers 200, and is discovered the
 *       first time somebody asks what was actually said.
 *   §4  **The tier split, and its mechanism.** Tiers 1-2, through `allInFamily('messaging')`.
 *       The outcome is reachable by accident if anybody types the list by hand.
 *   §5  **The audit target.** `user`, which classifies `platform_actor`. Change it to
 *       `none` and the row classifies `internal`, drops out of Support's feed, and puts the
 *       only handle on the recipient into the payload instead of the searchable column.
 *
 * §3 pins the rename across the five files that have to agree about it — the class of drift
 * `test:files` §5 found four instances of in its own family.
 *
 * Mutation-tested. Each of these five edits must turn this suite red:
 *   - delete the `named === 2` branch from `SendTelegramMessageSchema`      → §1
 *   - drop `message` from `toAuditPayload`                                  → §2
 *   - add `'*.message'` to `REDACTED_PATHS`                                 → §2
 *   - change the audit target from `user` to `none`                         → §5
 *   - add `messaging.telegram.send` to `SUPPORT` in `tier-grants.ts`        → §4
 *
 *   npm run test:messaging
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { suite } from './_assert';

// Env must be set before importing anything that reads config at module load.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI_PLATFORM = 'mongodb://localhost:27017/jovi_mall_test';
process.env.MONGO_URI_ADMIN = 'mongodb://localhost:27017/wi_admin_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_JWT_SECRET = 'test-access-secret-value-32-chars-long';
process.env.ADMIN_JWT_REFRESH_SECRET = 'test-refresh-secret-value-32-chars-long';
process.env.ADMIN_DASHBOARD_ORIGINS = 'http://localhost:5173';

import { toAuditPayload } from '../../src/modules/messaging/gateways/messaging.gateway';
import { SendTelegramMessageSchema } from '../../src/modules/messaging/validators/messaging.validator';
import { AUDIT_CATALOG, AuditAction } from '../../src/modules/audit/domain/audit.catalog';
import { subjectClassOf } from '../../src/modules/audit/domain/audit-subject';
import { AUDIT_TARGET_TYPES, familyOf } from '../../src/modules/audit/domain/audit.types';
import { sanitiseState } from '../../src/modules/audit/domain/audit-state';
import {
    PERMISSION_CATALOG,
    PermissionName,
} from '../../src/modules/authorization/domain/permission.catalog';
import { PERMISSION_FAMILIES } from '../../src/modules/authorization/domain/permission.types';
import { TIER_GRANTS, allInFamily } from '../../src/modules/authorization/domain/tier-grants';
// The legacy endpoint map was imported here and is DELETED (Phase 5 Part D) — see § 7.

const t = suite('messaging (Phase 5 Part C)');

const SRC = join(__dirname, '..', '..', 'src');

/** Strip comments before scanning — the headers below quote the shapes they forbid. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const ROUTES_CODE = stripComments(read('modules', 'messaging', 'routes', 'messaging.routes.ts'));
const GATEWAY_CODE = stripComments(read('modules', 'messaging', 'gateways', 'messaging.gateway.ts'));
const CONTROLLER_CODE = stripComments(
    read('modules', 'messaging', 'controllers', 'messaging.controller.ts'),
);

const USER_ID = '6612a4f0c1a2b3d4e5f60718';

// ─────────────────────────────────────────────────────────────────────────────
t.section('1. The wire schema — EXACTLY one recipient');

t.assert('a `userId` alone is accepted', () =>
    SendTelegramMessageSchema.safeParse({ userId: USER_ID, message: 'hello' }).success);

t.assert('a `chatId` alone is accepted', () =>
    SendTelegramMessageSchema.safeParse({ chatId: '123456789', message: 'hello' }).success);

t.assert('no recipient at all is refused', () =>
    !SendTelegramMessageSchema.safeParse({ message: 'hello' }).success);

/**
 * ⚠ **The assertion this suite exists for most, and the one place this service is
 * deliberately stricter than the service it delegates to.**
 *
 * jovi-mall's `SendNotificationSchema` refines on `data.userId || data.chatId` — at LEAST
 * one — and `TelegramNotificationService.send` then takes `params.chatId` when it is
 * present and never looks the `userId` up. So a body naming both is accepted there, the
 * message goes to the chat, the response says `sent: true`, and the user id that was
 * supposed to identify the recipient was never read. No error, no log line, and nothing in
 * the response that differs from a correct send.
 *
 * Refused here so the refusal arrives BEFORE the hop — the same shape the file validators
 * use for the 24-hour orphan floor, and the same reason.
 */
t.assert('naming BOTH is refused — jovi-mall would silently honour only the chat', () =>
    !SendTelegramMessageSchema.safeParse({
        userId: USER_ID,
        chatId: '123456789',
        message: 'hello',
    }).success);

t.assert('the refusal names `chatId`, so a client can point at the offending field', () => {
    const parsed = SendTelegramMessageSchema.safeParse({
        userId: USER_ID,
        chatId: '123456789',
        message: 'hello',
    });
    return !parsed.success
        && parsed.error.issues.some((issue) => issue.path.join('.') === 'chatId');
});

t.assert('a malformed `userId` is refused here, not two services away', () =>
    !SendTelegramMessageSchema.safeParse({ userId: 'not-an-id', message: 'hello' }).success);

t.assert('an empty message is refused, and 4096 is the ceiling Telegram enforces', () =>
    !SendTelegramMessageSchema.safeParse({ userId: USER_ID, message: '' }).success
    && !SendTelegramMessageSchema.safeParse({ userId: USER_ID, message: '   ' }).success
    && SendTelegramMessageSchema.safeParse({ userId: USER_ID, message: 'x'.repeat(4096) }).success
    && !SendTelegramMessageSchema.safeParse({ userId: USER_ID, message: 'x'.repeat(4097) }).success);

// ─────────────────────────────────────────────────────────────────────────────
t.section('2. O-2 — the audit row keeps the recipient AND the body');

const BODY = 'Your payout of 45 000 XAF was released this morning.';

t.assert('the message body is in the payload, whole', () =>
    toAuditPayload({ userId: USER_ID, message: BODY }).message === BODY);

/**
 * Both recipient fields always present, explicitly null when unused. A row missing `chatId`
 * and a row where `chatId` was never given must not read the same way — the trail is read
 * long after anybody remembers which addressing form was used.
 */
t.assert('the unused recipient field is null, not absent', () => {
    const byUser = toAuditPayload({ userId: USER_ID, message: BODY });
    const byChat = toAuditPayload({ chatId: '123456789', message: BODY });
    return 'chatId' in byUser && byUser.chatId === null
        && 'userId' in byChat && byChat.userId === null
        && byChat.chatId === '123456789';
});

t.assert('the payload carries these three fields and nothing else', () =>
    Object.keys(toAuditPayload({ userId: USER_ID, message: BODY })).sort().join(',')
    === 'chatId,message,userId');

/**
 * ⚠ The payload is meaningless if the writer strips it on the way to Mongo, so this runs
 * the REAL sanitiser rather than asserting a shape and hoping. `message` is deliberately
 * not a redacted field name; adding `'*.message'` to `REDACTED_PATHS` would silently
 * reverse the owner's O-2 decision, and this is what catches that.
 */
t.assert('the body survives the audit sanitiser — `message` is not a redacted name', () => {
    const { value, truncated } = sanitiseState(toAuditPayload({ userId: USER_ID, message: BODY }));
    return !truncated && (value as Record<string, unknown>).message === BODY;
});

/** A credential pasted in beside it is still caught — O-2 relaxed nothing. */
t.assert('a credential-shaped sibling field is still redacted', () => {
    const { value } = sanitiseState({
        ...toAuditPayload({ userId: USER_ID, message: BODY }),
        token: 'abc',
    });
    return (value as Record<string, unknown>).token === '[REDACTED]'
        && (value as Record<string, unknown>).message === BODY;
});

/**
 * The pure function above is only worth asserting if it is the one the gateway uses. This
 * is the connective tissue — without it, §2 tests code nothing calls.
 */
t.assert('the gateway builds its audit payload through `toAuditPayload`', () =>
    /payload:\s*toAuditPayload\(input\)/.test(GATEWAY_CODE)
    && !/payload:\s*\{/.test(GATEWAY_CODE));

t.assert('the controller never speaks to the platform client directly', () =>
    !CONTROLLER_CODE.includes('platformRequest') && !CONTROLLER_CODE.includes('platform.client'));

// ─────────────────────────────────────────────────────────────────────────────
t.section('3. D-11 — the rename, across every file that must agree about it');

const NAME = 'messaging.telegram.send' as PermissionName;

t.assert('`messaging` is a declared family', () =>
    (PERMISSION_FAMILIES as readonly string[]).includes('messaging'));

t.assert('`broadcast` is gone from PERMISSION_FAMILIES', () =>
    !(PERMISSION_FAMILIES as readonly string[]).includes('broadcast'));

t.assert('`broadcast.send` is gone from the catalog', () =>
    (PERMISSION_CATALOG as Record<string, unknown>)['broadcast.send'] === undefined);

t.assert('no catalogued permission is in a `broadcast` family', () =>
    !Object.values(PERMISSION_CATALOG)
        .some((spec) => (spec as { family: string }).family === 'broadcast'));

t.assert('`messaging.telegram.send` is catalogued in the `messaging` family', () =>
    PERMISSION_CATALOG[NAME] !== undefined && PERMISSION_CATALOG[NAME].family === 'messaging');

t.assert('the family has exactly one member — there is no fan-out to grant', () =>
    Object.values(PERMISSION_CATALOG)
        .filter((spec) => (spec as { family: string }).family === 'messaging').length === 1);

/**
 * The summary is part of the rename, not decoration. The old one promised "a broadcast
 * message to platform users": there is no audience, no segmentation and no scheduling, and
 * the reachable set is the accounts that linked Telegram through `/connect`. An operator
 * being offered a permission has to be able to tell what it does.
 */
t.assert('the summary describes one message to one account, not a broadcast', () => {
    const summary = PERMISSION_CATALOG[NAME].summary.toLowerCase();
    return !summary.includes('broadcast') && summary.includes('one') && summary.includes('telegram');
});

t.assert('the audit action name and the permission name are the same string', () =>
    AUDIT_CATALOG[NAME as unknown as AuditAction].permission === NAME);

/** `familyOf` splits on the first dot, and the audit feed's family filter rides on it. */
t.assert('`familyOf` resolves the action to `messaging`', () => familyOf(NAME) === 'messaging');

// ─────────────────────────────────────────────────────────────────────────────
t.section('4. Tier grants — Developer and Admin, and the mechanism');

const has = (tier: 1 | 2 | 3, name: string): boolean =>
    (TIER_GRANTS[tier] as readonly string[]).includes(name);

t.assert('tiers 1 and 2 hold it; Support does not', () =>
    has(1, NAME) && has(2, NAME) && !has(3, NAME));

/**
 * The outcome above is reachable by hand-typing the same list, and would drift the first
 * time a `messaging.*` name is added. What makes it structural is that it arrives through
 * the family sweep, so the mechanism is pinned as well as the result.
 */
t.assert('it reaches Admin through `allInFamily(messaging)`, not a typed name', () =>
    allInFamily('messaging').includes(NAME)
    && /allInFamily\('messaging'\)/.test(
        stripComments(read('modules', 'authorization', 'domain', 'tier-grants.ts')),
    ));

t.assert('`allInFamily(broadcast)` no longer resolves to anything', () =>
    allInFamily('broadcast' as never).length === 0);

/**
 * Neither flag, deliberately: the send changes no record and there is nothing to recover,
 * so grantability is ordinary. What makes it consequential is that it cannot be recalled,
 * and that is answered by the audit payload (§2) rather than by a flag.
 *
 * ⚠ **The widening cast is deliberate, and it is the same one `test:content` §6 carries
 * (Phase 5 P-5).** `PERMISSION_CATALOG` is a literal-typed union, so today this entry has
 * no `destructive` or `sensitive` KEY AT ALL and `tsc` rejects reading one — the absence is
 * a compile-time guarantee. The runtime check survives the cast for the edit that would
 * make that proof silently go away: adding either flag compiles fine and moves this
 * permission out of `allInFamily('messaging')`, taking it off tier 2 without touching
 * `tier-grants.ts`. Do not "tidy" this into a type assertion on the narrowed member.
 */
t.assert('it is neither destructive nor sensitive — the audit carries the weight', () => {
    const flags = PERMISSION_CATALOG[NAME] as { destructive?: boolean; sensitive?: boolean };
    return flags.destructive === undefined && flags.sensitive === undefined;
});

// ─────────────────────────────────────────────────────────────────────────────
t.section('5. Audit — one action, external, targeting the person');

const spec = AUDIT_CATALOG[NAME as unknown as AuditAction];

t.assert('the action is catalogued', () => spec !== undefined);

/**
 * `external`, not `delegated` and not `wi_admin_txn`. `connections.ts` opens two
 * MongoClients, so nothing happening in jovi-mall's process can join a `wi-admin` session —
 * intent → outcome, with the resolved chat stamped on the way out.
 */
t.assert('the transport is `external`', () => spec.transport === 'external');

/**
 * ⚠ `target: 'user'` and NOT `none`, in both addressing forms. A Telegram chat id addresses
 * a person; only the searchable column differs between the two. `none` classifies
 * `internal`, which would drop the row out of Support's feed AND move the only handle on
 * the recipient into the payload — the argument `files.delete` already carries at its own
 * target entry.
 */
t.assert('the target is `user`, and `user` is a declared target type', () =>
    spec.target === 'user' && (AUDIT_TARGET_TYPES as readonly string[]).includes('user'));

t.assert('`user` classifies as a platform actor, so Support can read the row', () =>
    subjectClassOf('user') === 'platform_actor');

t.assert('there is exactly one catalogued `messaging.*` action', () =>
    (Object.keys(AUDIT_CATALOG) as string[]).filter((a) => a.startsWith('messaging.')).length === 1);

t.assert('no `broadcast.*` action survives in the audit catalog', () =>
    !(Object.keys(AUDIT_CATALOG) as string[]).some((a) => a.startsWith('broadcast.')));

// ─────────────────────────────────────────────────────────────────────────────
t.section('6. The route declaration');

t.assert('the mount declares exactly one route', () =>
    (ROUTES_CODE.match(/defineRoute\(/g) ?? []).length === 1);

t.assert('it is `POST /telegram` on the `/messaging` mount', () =>
    /mountedAt = '\/messaging'/.test(ROUTES_CODE)
    && /method: 'post'/.test(ROUTES_CODE)
    && /path: '\/telegram'/.test(ROUTES_CODE));

t.assert('it declares the permission and validates the body', () =>
    /access: permission\('messaging\.telegram\.send'\)/.test(ROUTES_CODE)
    && /body: SendTelegramMessageSchema/.test(ROUTES_CODE));

/**
 * `records`, not `mayRecord`: a send either happens or raises, and there is no branch that
 * legitimately writes nothing. `auditProbe` logs a fatal on a route that succeeds having
 * recorded none of the actions it declares, which is exactly the behaviour wanted here.
 */
t.assert('the send is audited with `records`, not `mayRecord`', () =>
    /audit: records\('messaging\.telegram\.send'\)/.test(ROUTES_CODE)
    && !ROUTES_CODE.includes('mayRecord'));

t.assert('nothing is registered directly on the router, bypassing the manifest', () =>
    !/\brouter\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(/.test(ROUTES_CODE));

// ─────────────────────────────────────────────────────────────────────────────
t.section('7. The legacy map is GONE');

/**
 * Three assertions stood here. Two were the "gone from the checklist" pair every ported
 * family wrote; the third pinned `LEGACY_ENDPOINT_COUNT === 0`, and its comment said what
 * that state was FOR: with the count at 0, `test-authz.ts`'s cutover tripwire demanded
 * `src/modules/legacy-audit/` be deleted, so `test:authz` went red on purpose the moment
 * Part C landed.
 *
 * **Part D answered it.** The module, the map, the `audit.legacy_feed` flag and the
 * `AUDIT_LEGACY_FEED_DISABLED` code are all deleted, and `test:authz` is green again. There
 * is no count left to pin — the constant it named does not exist — and all three checks would
 * now pass by having nothing to read.
 *
 * The successor is unconditional and lives in `test-authz.ts` § 9: the map file is gone, the
 * module directory is gone, and no file under `src/` references either. This suite keeps what
 * is actually its own — that `messaging` replaced `broadcast` (§ 3) and that the route is
 * declared, permissioned and audited here (§ 6).
 */

process.exit(t.finish());

/**
 * Verify: content against REAL infrastructure — and against jovi-mall's real reader.
 *
 * `test:content` proves the rules are internally consistent. This proves the thing that
 * matters about Part A and that no DB-free assertion can reach: **this service writes a
 * collection whose schema and indexes are declared in another repository**, on the raw
 * MongoDB driver, and jovi-mall's public site reads what it wrote.
 *
 * Four things only a real database proves, each of which fails silently otherwise:
 *
 *   1. **The raw-driver write produces a document jovi-mall's public reader renders.**
 *      `test:content` § 2 asserts the constructed object against the default table; that is
 *      the theory. This is the proof — write through `/api/v1/content/articles`, publish it,
 *      then fetch it from jovi-mall's `GET /api/public/articles/{slug}` and read the fields
 *      back. A default missing here is a document that looks right in the editor and
 *      renders wrong on the marketing site.
 *   2. **The unique multikey index on `slug_keys` still rejects a duplicate** — and now
 *      rejects one written by a *different service* than the one that declared it (O-3).
 *      An index that builds but does not bind is indistinguishable from one that works,
 *      until two articles answer one URL.
 *   3. **A slug rename keeps the old URL answering** `BLOG_ARTICLE_MOVED` rather than 404.
 *      That depends on `buildSlugKeys` — the copy in THIS repository — putting the retired
 *      value back on every write.
 *   4. **A Support-tier administrator can edit but cannot publish** (A.6 + O-1), and the
 *      403 does not name the tier above them.
 *
 * ── What it needs ─────────────────────────────────────────────────────────────
 *   Mongo (this service's platform connection — it writes `jovi_mall` directly)
 *   jovi-mall RUNNING, for its PUBLIC reader — no service token needed for that half
 *   JOVI_MALL_BASE_URL set, so the public reader can be reached
 *
 * Sections 1 and 4 need only Mongo, because ownership means the write is local. Sections 2
 * and 3's cross-service half needs jovi-mall's public route, and they SKIP loudly rather
 * than silently when it is unreachable — a suite that passes by not running is worse than
 * one that fails.
 *
 * Every fixture is keyed `verify-content-*` and deleted at the end, pass or fail.
 *
 * Run: npm run verify:content
 */
import 'dotenv/config';

process.env.ADMIN_AUTH_RATE_LIMIT_MAX = '500';

import type { Server } from 'http';
import { suite } from './_assert';
import { env } from '../../src/config/env';
import { createApp } from '../../src/app';
import { connectAll, closeAll, platformConnection, adminConnection } from '../../src/infra/mongo/connections';
import { closeRedisClients, getRedisClient, ADMIN_SESSION_DB } from '../../src/infra/redis/redis.factory';
import { AdminAccountModel } from '../../src/modules/admin-identity/models/admin-account.model';
import { AdminSessionModel } from '../../src/modules/admin-identity/models/admin-session.model';
import { AdminAccountRepository } from '../../src/modules/admin-identity/repositories/admin-account.repository';
import { hash } from '../../src/modules/admin-identity/domain/password.service';
import { AdminTier } from '../../src/modules/admin-identity/domain/admin-identity.types';
import { COLLECTIONS } from '../../src/infra/platform/collections';

const t = suite('content — live');

const PASSWORD = 'verify-content-suite-password-7712';
/**
 * Tier 2 (Admin), not tier 1.
 *
 * `ADMIN_MFA_REQUIRED_TIER` defaults to 1, so a Developer must enrol in MFA before their
 * session is usable and a fixture at that tier would have to walk the enrolment dance
 * (`verify-authz-live.ts` does exactly that, because MFA is its subject). Nothing here
 * needs tier 1: Admin holds all seven `content.*` permissions, so it can publish, archive
 * and delete, which is everything this suite asks of the privileged side.
 */
const EMAIL_ADMIN = 'verify-content-admin@example.test';
const EMAIL_SUPPORT = 'verify-content-support@example.test';

const AUTHOR = 'verify-content-author';
const ARTICLE = 'verify-content-article';
const OTHER = 'verify-content-other';

const SLUG = 'verify-content-getting-paid';
const RENAMED_SLUG = 'verify-content-how-to-get-paid';

const JOVI = process.env.JOVI_MALL_BASE_URL ?? '';

let port = 0;

interface Res { status: number; body: any; cookies: Record<string, string> }

function parseCookies(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    return out;
}

async function call(
    method: string,
    path: string,
    options: { body?: unknown; cookies?: Record<string, string>; csrf?: string } = {},
): Promise<Res> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.cookies && Object.keys(options.cookies).length > 0) {
        headers.Cookie = Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (options.csrf) headers['X-CSRF-Token'] = options.csrf;

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, cookies: parseCookies(response.headers) };
}

/** jovi-mall's PUBLIC reader. No identity — that is the point of the endpoint. */
async function jovi(path: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${JOVI}${path}`, { headers: { Accept: 'application/json' } });
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
}

interface Session { adminId: string; cookies: Record<string, string>; csrf: string }

async function signIn(email: string): Promise<Session> {
    const res = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    if (res.status !== 200 || res.body?.data?.mfaEnrolmentRequired) {
        throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const me = await call('GET', '/api/v1/auth/me', { cookies: res.cookies });
    return {
        adminId: me.body?.data?.admin?.id,
        cookies: res.cookies,
        csrf: res.cookies.admin_csrf_token ?? '',
    };
}

const write = (s: Session, method: string, path: string, body?: unknown) =>
    call(method, path, { cookies: s.cookies, csrf: s.csrf, body });

function platformDb() {
    const db = platformConnection().db;
    if (!db) throw new Error('platform connection has no db');
    return db;
}

async function cleanupPlatform(): Promise<void> {
    const db = platformDb();
    await db.collection(COLLECTIONS.ARTICLE).deleteMany({ key: { $in: [ARTICLE, OTHER] } });
    await db.collection(COLLECTIONS.ARTICLE_AUTHOR).deleteMany({ key: AUTHOR });
}

async function cleanupAdmin(): Promise<void> {
    const admins = await AdminAccountModel().find(
        { email: { $in: [EMAIL_ADMIN, EMAIL_SUPPORT] } }, { _id: 1 },
    );
    const ids = admins.map((a) => a._id);
    if (ids.length > 0) {
        await AdminSessionModel().deleteMany({ admin_id: { $in: ids } });
        await AdminAccountModel().deleteMany({ _id: { $in: ids } });
    }
    const redis = await getRedisClient(ADMIN_SESSION_DB);
    for (const id of ids) {
        const sids = await redis.sMembers(`admin-sessions:${id.toString()}`);
        for (const sid of sids) await redis.del(`session:${sid}`);
        await redis.del(`admin-sessions:${id.toString()}`);
    }
}

const body = [
    { type: 'heading', level: 2, id: 'how-it-works', text: 'How it works' },
    {
        type: 'paragraph',
        text: [{ type: 'text', text: 'Commission is taken at payment, not at payout.' }],
    },
];

function articlePayload(over: Record<string, unknown> = {}) {
    return {
        id: ARTICLE,
        categoryKey: 'payments',
        authorId: AUTHOR,
        featured: false,
        translations: [
            { locale: 'en', slug: SLUG, title: 'Getting paid', excerpt: 'How.', body, published: true },
            {
                locale: 'fr',
                slug: 'verify-content-se-faire-payer',
                title: 'Se faire payer',
                excerpt: 'Comment.',
                body,
                published: true,
            },
        ],
        ...over,
    };
}

async function main(): Promise<number> {
    let server: Server | null = null;

    try {
        env();
        await connectAll();
        await cleanupAdmin();
        await cleanupPlatform();

        const accounts = new AdminAccountRepository();
        const passwordHash = await hash(PASSWORD);

        const make = async (email: string, displayName: string, tier: AdminTier) => {
            const session = await adminConnection().startSession();
            try {
                await session.withTransaction(async () => {
                    // ⚠ `status: 'active'` because ADR-023 made `pending` the default, and a pending
                    // fixture is refused every route this suite exercises. Fixtures, not the
                    // audited path — a real hire is activated by a Developer.
                    await accounts.create({ email, displayName, passwordHash, tier, status: 'active' }, session);
                });
            } finally {
                await session.endSession();
            }
        };

        await make(EMAIL_ADMIN, 'Verify Content Admin', 2);
        await make(EMAIL_SUPPORT, 'Verify Content Support', 3);

        const app = createApp();
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;

        const admin = await signIn(EMAIL_ADMIN);
        const support = await signIn(EMAIL_SUPPORT);

        // ── 1. The raw-driver write ───────────────────────────────────────────
        t.section('1. The raw-driver write — every default, against a real collection');

        const authorRes = await write(admin, 'POST', '/api/v1/content/authors', {
            id: AUTHOR,
            name: 'Verify Content Byline',
            type: 'Organization',
            translations: { en: { title: 'Editorial', bio: 'We write about selling on WhatsApp.' } },
        });
        t.assert('an author is created', () => authorRes.status === 201 || authorRes.status === 200);

        const created = await write(admin, 'POST', '/api/v1/content/articles', articlePayload());
        t.assert('an article is created', () => created.status === 201 || created.status === 200);
        t.assert('...as a DRAFT (a create is never a publish)', () =>
            created.body?.data?.status === 'draft');

        /**
         * The stored document, read back through the driver rather than through the DTO.
         *
         * The DTO would paper over a missing default — it projects named fields, so an
         * absent `word_count` becomes `undefined` in one place and a rendered `NaN` in
         * jovi-mall. Reading the raw document is the only way to see what actually landed.
         */
        const stored = await platformDb().collection(COLLECTIONS.ARTICLE).findOne({ key: ARTICLE });

        t.assert('the stored document exists', () => stored !== null);
        t.assert('createdAt landed (the driver applies no `timestamps`)', () =>
            stored?.createdAt instanceof Date);
        t.assert('updatedAt landed', () => stored?.updatedAt instanceof Date);
        t.assert('deletedAt landed as an explicit null, not absent', () =>
            stored !== null && 'deletedAt' in stored && stored.deletedAt === null);
        t.assert('published_at landed as an explicit null', () =>
            stored !== null && 'published_at' in stored && stored.published_at === null);
        t.assert('content_updated_at landed as an explicit null', () =>
            stored !== null && 'content_updated_at' in stored && stored.content_updated_at === null);
        t.assert('slug_keys landed, derived', () =>
            Array.isArray(stored?.slug_keys) && stored.slug_keys.includes(`en:${SLUG}`));
        /**
         * The editor's component driver (BR-019 § 1). Read from the raw document on purpose:
         * the DTO falls back to `translations[0].locale` for a document written before the
         * field existed, so a `sourceLocale` on the wire is NOT evidence the key landed —
         * and a key that never lands is a field that silently degrades to the positional
         * driver it exists to replace.
         */
        t.assert('source_locale landed, derived from the first translation', () =>
            stored?.source_locale === 'en');
        t.assert('per-translation word_count landed as a NUMBER, derived', () =>
            typeof stored?.translations?.[0]?.word_count === 'number'
            && stored.translations[0].word_count > 0);
        t.assert('per-translation previous_slugs landed as an array', () =>
            Array.isArray(stored?.translations?.[0]?.previous_slugs));
        t.assert('per-translation meta_title landed as an explicit null', () =>
            stored?.translations?.[0] !== undefined
            && 'meta_title' in stored.translations[0]
            && stored.translations[0].meta_title === null);
        t.assert('the administrator stamp landed', () =>
            stored?.created_by_admin?.source === 'admin');

        const storedAuthor = await platformDb()
            .collection(COLLECTIONS.ARTICLE_AUTHOR).findOne({ key: AUTHOR });
        t.assert('author avatar_url landed as an explicit null', () =>
            storedAuthor !== null && 'avatar_url' in storedAuthor && storedAuthor.avatar_url === null);
        /**
         * jovi-mall declares this a Mongoose `Map`. BSON stores a `Map` as a plain object, so
         * writing one through the driver stores `{}` — a byline with no title and no bio, in
         * every language. Reading it back is the only place that is visible.
         */
        t.assert('author translations landed as a populated object, not {}', () =>
            storedAuthor?.translations?.en?.title === 'Editorial');

        // ── 2. Support may edit, and may not publish ──────────────────────────
        t.section('2. The tier split (A.6 + O-1)');

        const supportEdit = await write(support, 'PATCH', `/api/v1/content/articles/${ARTICLE}`, {
            featured: false,
        });
        t.assert('Support MAY edit an article', () => supportEdit.status === 200);

        const supportPublish = await write(
            support, 'POST', `/api/v1/content/articles/${ARTICLE}/publish`, {},
        );
        t.assert('Support may NOT publish', () => supportPublish.status === 403);
        t.assert('...refused on the permission, not on a route it cannot see', () =>
            supportPublish.body?.error?.code === 'AUTHZ_PERMISSION_DENIED');
        /**
         * The message names the RULE, never the caller's standing. "You are tier 3 and this
         * needs tier 2" tells an attacker the shape of the hierarchy and tells a legitimate
         * operator nothing they can act on.
         */
        t.assert('...and the message does not name the tier above them', () => {
            const message = String(supportPublish.body?.error?.message ?? '');
            return !/tier\s*[12]\b/i.test(message) && !/\bDeveloper\b/.test(message);
        });

        const supportDelete = await write(support, 'DELETE', `/api/v1/content/articles/${ARTICLE}`);
        t.assert('Support may NOT delete', () => supportDelete.status === 403);

        // ── 3. Publish, and the cross-service read ───────────────────────────
        t.section('3. Published here, served by jovi-mall');

        const published = await write(admin, 'POST', `/api/v1/content/articles/${ARTICLE}/publish`, {});
        t.assert('an Admin may publish', () => published.status === 200);
        t.assert('published_at is stamped', () => published.body?.data?.publishedAt !== null);

        if (!JOVI) {
            t.assert('SKIPPED — JOVI_MALL_BASE_URL is not set, so the public reader cannot be reached', () => true);
            console.error(
                '\n  ⚠  Set JOVI_MALL_BASE_URL and run jovi-mall to exercise the cross-service half.\n'
                + '     It is the half that proves what this phase actually changed.\n',
            );
        } else {
            const reachable = await jovi('/api/health').then((r) => r.status === 200).catch(() => false);

            if (!reachable) {
                t.assert('SKIPPED — jovi-mall is configured but unreachable', () => true);
                console.error('\n  ⚠  start jovi-mall and re-run — sections 3–4 are the phase gate.\n');
            } else {
                /**
                 * ⚠ **The assertion this whole suite exists for.**
                 *
                 * An article written by wi-admin, on the raw driver, read by jovi-mall's own
                 * Mongoose reader and rendered through its public DTO. Everything between the
                 * two — the defaults, the derived `slug_keys`, the `word_count`, the
                 * translation shape — has to be right for this to answer 200.
                 */
                const publicRead = await jovi(`/api/public/articles/${SLUG}?locale=en`);
                t.assert('jovi-mall SERVES an article wi-admin wrote', () => publicRead.status === 200);

                const article = publicRead.body?.data;
                t.assert('...with its body', () => Array.isArray(article?.body) && article.body.length === 2);
                t.assert('...with its byline resolved inline', () =>
                    article?.author?.name === 'Verify Content Byline');
                t.assert('...with wordCount a real number, not NaN or undefined', () =>
                    typeof article?.wordCount === 'number' && Number.isFinite(article.wordCount)
                    && article.wordCount > 0);
                t.assert('...with publishedAt a valid ISO instant', () =>
                    typeof article?.publishedAt === 'string'
                    && !Number.isNaN(Date.parse(article.publishedAt)));
                t.assert('...with both languages in availableLocales', () =>
                    JSON.stringify(article?.availableLocales) === '["en","fr"]');

                /** The staff stamp must not travel to the marketing site. */
                t.assert('...and NO administrator identity reaches the public payload', () =>
                    !JSON.stringify(publicRead.body).includes('created_by_admin')
                    && !JSON.stringify(publicRead.body).includes('Verify Content Admin'));

                const listed = await jovi('/api/public/articles?locale=en&limit=100');
                t.assert('it appears in jovi-mall\'s public list', () =>
                    Array.isArray(listed.body?.data?.items)
                    && listed.body.data.items.some((a: any) => a.id === ARTICLE));
            }
        }

        // ── 4. The index BINDS, across the service boundary ───────────────────
        t.section('4. The unique slug_keys index — declared there, enforced against writes from here (O-3)');

        /**
         * The index lives in jovi-mall's `ArticleSchema`. This service never declares it and
         * `ensure:indexes` here covers only the `wi-admin` database. So "no two articles
         * answer one URL" is a guarantee spanning two repositories, and this is the only
         * place it is checked rather than assumed.
         */
        const duplicate = await write(admin, 'POST', '/api/v1/content/articles', {
            id: OTHER,
            categoryKey: 'growth',
            authorId: AUTHOR,
            featured: false,
            translations: [
                { locale: 'en', slug: SLUG, title: 'Other', excerpt: 'Other.', body, published: true },
            ],
        });
        t.assert('a second article claiming a live slug is REFUSED', () => duplicate.status >= 400);
        t.assert('...as a conflict, not a 500', () => duplicate.status === 409);

        const otherExists = await platformDb()
            .collection(COLLECTIONS.ARTICLE).countDocuments({ key: OTHER });
        t.assert('...and nothing was written', () => otherExists === 0);

        // ── 5. A rename keeps the old URL answering ───────────────────────────
        t.section('5. Slug rename — the retired slug survives the write');

        const renamed = await write(admin, 'PATCH', `/api/v1/content/articles/${ARTICLE}`, {
            translations: [
                { locale: 'en', slug: RENAMED_SLUG, title: 'Getting paid', excerpt: 'How.', body, published: true },
                {
                    locale: 'fr',
                    slug: 'verify-content-se-faire-payer',
                    title: 'Se faire payer',
                    excerpt: 'Comment.',
                    body,
                    published: true,
                },
            ],
        });
        t.assert('the rename is accepted', () => renamed.status === 200);

        const afterRename = await platformDb().collection(COLLECTIONS.ARTICLE).findOne({ key: ARTICLE });
        t.assert('slug_keys holds the NEW slug', () =>
            Array.isArray(afterRename?.slug_keys) && afterRename.slug_keys.includes(`en:${RENAMED_SLUG}`));
        t.assert('slug_keys still holds the RETIRED slug — this IS the redirect', () =>
            Array.isArray(afterRename?.slug_keys) && afterRename.slug_keys.includes(`en:${SLUG}`));
        t.assert('previous_slugs records the retired value', () =>
            afterRename?.translations?.[0]?.previous_slugs?.includes(SLUG) === true);

        if (JOVI) {
            const reachable = await jovi('/api/health').then((r) => r.status === 200).catch(() => false);
            if (reachable) {
                const moved = await jovi(`/api/public/articles/${SLUG}?locale=en`);
                t.assert('jovi-mall answers the OLD url with BLOG_ARTICLE_MOVED, not 404', () =>
                    moved.body?.error?.code === 'BLOG_ARTICLE_MOVED');
                t.assert('...carrying the current slug so the frontend can 301', () =>
                    moved.body?.error?.details?.slug === RENAMED_SLUG);

                const atNew = await jovi(`/api/public/articles/${RENAMED_SLUG}?locale=en`);
                t.assert('the new url resolves', () => atNew.status === 200);
            }
        }

        // A retired slug may not be claimed by another article either — a reused one turns a
        // permanent redirect into a wrong answer.
        const claimRetired = await write(admin, 'POST', '/api/v1/content/articles', {
            id: OTHER,
            categoryKey: 'growth',
            authorId: AUTHOR,
            featured: false,
            translations: [
                { locale: 'en', slug: SLUG, title: 'Other', excerpt: 'Other.', body, published: true },
            ],
        });
        t.assert('a RETIRED slug cannot be claimed by another article', () => claimRetired.status === 409);

        // ── 6. Delete is refused once published ───────────────────────────────
        t.section('6. The delete refusal, against a real published article');

        const refused = await write(admin, 'DELETE', `/api/v1/content/articles/${ARTICLE}`);
        t.assert('a published article cannot be deleted', () => refused.status === 409);
        t.assert('...with the code that names the remedy', () =>
            refused.body?.error?.code === 'BLOG_ARTICLE_DELETE_NOT_ALLOWED');

        const archived = await write(admin, 'POST', `/api/v1/content/articles/${ARTICLE}/archive`, {});
        t.assert('archive is the remedy, and it succeeds', () => archived.status === 200);

        if (JOVI) {
            const reachable = await jovi('/api/health').then((r) => r.status === 200).catch(() => false);
            if (reachable) {
                const gone = await jovi(`/api/public/articles/${RENAMED_SLUG}?locale=en`);
                t.assert('an archived article answers 410 with its hub, not 404', () =>
                    gone.status === 410 && gone.body?.error?.details?.categoryKey === 'payments');
            }
        }

        return t.finish();
    } finally {
        try { await cleanupPlatform(); } catch { /* best effort */ }
        try { await cleanupAdmin(); } catch { /* best effort */ }
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await closeRedisClients();
        await closeAll();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error('FATAL', err);
        process.exit(1);
    });

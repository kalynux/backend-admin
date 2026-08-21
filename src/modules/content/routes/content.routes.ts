import { Router } from 'express';
import { defineRoute, permission, records } from '../../../api/route-manifest';
import { ContentArticleController, ContentAuthorController } from '../controllers/content.controller';
import {
    ArticleKeyParamSchema,
    AuthorKeyParamSchema,
    CreateArticleSchema,
    CreateAuthorSchema,
    ListAuthorsQuerySchema,
    NoBodySchema,
    PreviewQuerySchema,
    PublishArticleSchema,
    SearchArticlesQuerySchema,
    UpdateArticleSchema,
    UpdateAuthorSchema,
} from '../validators/article.validator';

/**
 * `/api/v1/content` — the editor behind the public blog.
 *
 * The seven `content.*` permissions were catalogued at Phase 3 and had no endpoint until
 * now; this is the surface they were written for. jovi-mall's `/api/admin/articles` and
 * `/api/admin/article-authors` mounts are **deleted** in the same change (Phase 17 D-7), so
 * this is the only editorial door onto either collection.
 *
 * ── One mount, two `:id` namespaces ───────────────────────────────────────────
 * jovi-mall served two routers at two prefixes so each kept its own `:id`. Here they are one
 * route group with two literal segments — `/articles/:articleKey`, `/authors/:authorKey` —
 * which reads the same way in `docs/api/README.md`'s group list and needs no second mount.
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * `/authors` is a literal sibling of nothing (`:articleKey` lives under `/articles/`), so
 * unlike the support router there is no shadowing hazard here. The nesting is what removes
 * it; do not flatten these onto the root.
 *
 * ── Four permissions, and the split is the tier boundary ──────────────────────
 * `read` and `write` are held by every tier including Support (Phase 17 D-2); `publish` and
 * both `delete`s are not. That is the entire access model for this surface — there is no row
 * scope, because an article belongs to nobody. A Support administrator may fix a typo in
 * live prose and may not decide what the public sees, which is the shape D-2 asked for.
 *
 * ⚠ **Paths key on the stable string `key`**, not an ObjectId. `getting-paid-on-whatsapp`,
 * not a 24-hex value: the shared `objectId` validator would refuse every real id here.
 */
const router = Router();
const mountedAt = '/content';

// ─── Articles ────────────────────────────────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/articles',
    access: permission('content.articles.read'),
    validate: { query: SearchArticlesQuerySchema },
    handler: ContentArticleController.search,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/articles',
    access: permission('content.articles.write'),
    validate: { body: CreateArticleSchema },
    audit: records('content.articles.create'),
    handler: ContentArticleController.create,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/articles/:articleKey',
    access: permission('content.articles.read'),
    validate: { params: ArticleKeyParamSchema },
    handler: ContentArticleController.get,
});

/**
 * The public shape, at any status, behind the admin guard.
 *
 * `content.articles.read` rather than a permission of its own: it discloses nothing the
 * detail read above does not, in a smaller projection. What it is FOR is that previewing
 * never becomes an argument for a `?includeDrafts=` flag on jovi-mall's public route — see
 * `read-models/public-article.dto.ts`.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/articles/:articleKey/preview',
    access: permission('content.articles.read'),
    validate: { params: ArticleKeyParamSchema, query: PreviewQuerySchema },
    handler: ContentArticleController.preview,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/articles/:articleKey',
    access: permission('content.articles.write'),
    validate: { params: ArticleKeyParamSchema, body: UpdateArticleSchema },
    audit: records('content.articles.update'),
    handler: ContentArticleController.update,
});

/**
 * Publish, unpublish and archive share **one permission and three audit actions**.
 *
 * One permission because they are one decision — who controls what the public sees — and
 * three rows because they are three different acts. Archiving is not a stronger unpublish:
 * an archived URL answers `410 Gone` with its category hub so an inbound link lands
 * somewhere, while a drafted one simply 404s. A trail that could not tell them apart would
 * lose the only record of which an operator chose.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/articles/:articleKey/publish',
    access: permission('content.articles.publish'),
    validate: { params: ArticleKeyParamSchema, body: PublishArticleSchema },
    audit: records('content.articles.publish'),
    handler: ContentArticleController.publish,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/articles/:articleKey/unpublish',
    access: permission('content.articles.publish'),
    validate: { params: ArticleKeyParamSchema, body: NoBodySchema },
    audit: records('content.articles.unpublish'),
    handler: ContentArticleController.unpublish,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/articles/:articleKey/archive',
    access: permission('content.articles.publish'),
    validate: { params: ArticleKeyParamSchema, body: NoBodySchema },
    audit: records('content.articles.archive'),
    handler: ContentArticleController.archive,
});

/**
 * Delete — refused once the article has ever been published (`409`), and a **soft** delete
 * even then.
 *
 * The permission is `destructive`, which is what keeps it out of `allInFamily()` and
 * therefore out of Support's grant. The flag is right; the catalogued summary that called
 * this a permanent removal was not, and is corrected.
 */
defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/articles/:articleKey',
    access: permission('content.articles.delete'),
    validate: { params: ArticleKeyParamSchema },
    audit: records('content.articles.delete'),
    handler: ContentArticleController.remove,
});

// ─── Authors ─────────────────────────────────────────────────────────────────

/**
 * The byline directory. **Not paginated** — a deliberate exception to this service's list
 * contract, explained at `ListAuthorsQuerySchema`.
 */
defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/authors',
    access: permission('content.authors.read'),
    validate: { query: ListAuthorsQuerySchema },
    handler: ContentAuthorController.list,
});

defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/authors',
    access: permission('content.authors.write'),
    validate: { body: CreateAuthorSchema },
    audit: records('content.authors.create'),
    handler: ContentAuthorController.create,
});

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/authors/:authorKey',
    access: permission('content.authors.read'),
    validate: { params: AuthorKeyParamSchema },
    handler: ContentAuthorController.get,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/authors/:authorKey',
    access: permission('content.authors.write'),
    validate: { params: AuthorKeyParamSchema, body: UpdateAuthorSchema },
    audit: records('content.authors.update'),
    handler: ContentAuthorController.update,
});

/** Refused while any article credits this byline (`409 BLOG_AUTHOR_IN_USE`). */
defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/authors/:authorKey',
    access: permission('content.authors.delete'),
    validate: { params: AuthorKeyParamSchema },
    audit: records('content.authors.delete'),
    handler: ContentAuthorController.remove,
});

export { router as contentRoutes };

import { Request, Response } from 'express';
import { asyncHandler } from '../../../core/http/async-handler';
import { sendCreated, sendPaginated, sendSuccess } from '../../../core/http/responses';
import { requireAdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { actorContextOf } from '../../audit/domain/audit-context';
import { adminAuthorStampOf } from '../domain/admin-author';
import { ArticleAuthorDocument, ArticleDocument } from '../domain/article.document';
import { auditedContentWrite } from '../gateways/content.audit';
import {
    toAdminArticleAuthorDto,
    toAdminArticleDto,
    toAdminArticleSummaryDto,
} from '../read-models/article.dto';
import { toPublicArticleDetailDto } from '../read-models/public-article.dto';
import { articleAuthorService } from '../services/article-author.service';
import { articleService } from '../services/article.service';
import {
    CreateArticleBody,
    CreateAuthorBody,
    PreviewQuery,
    PublishArticleBody,
    SearchArticlesQuery,
    UpdateArticleBody,
    UpdateAuthorBody,
} from '../validators/article.validator';

/**
 * `/api/v1/content` — the editor for the public blog.
 *
 * ── The one surface on this service that writes `jovi_mall` directly ──────────
 * Every other domain here reads records directly and delegates writes over jovi-mall's
 * internal admin API (ADR-004 D-2). Content is the single exception, and it is the exception
 * ADR-004 D-4 wrote down in advance: `ArticleService` and `ArticleAuthorService` had **no
 * non-admin caller** — jovi-mall's public site reads through a separate
 * `public-article.service` — and no in-process subscriber, so there is no event a second
 * writer would fail to publish. That is exactly the property tickets lack, which is why
 * tickets stayed delegated and this did not.
 *
 * ── There is no scope here, and that is not an omission ───────────────────────
 * A ticket is scoped because it belongs to somebody: `resolveScope('tickets')` folds the
 * tier matrix into the query so a Support administrator cannot reach an Admin's ticket. An
 * article belongs to nobody. Every holder of `content.articles.read` may read every
 * article, and what separates the tiers is the four permissions, not a row filter —
 * `content.articles.publish` and both `delete`s are withheld from Support, so a Support
 * administrator can write prose and cannot decide what the public sees.
 *
 * ── Where the audit row is written ────────────────────────────────────────────
 * Here, not in the service, and through `auditedContentWrite` rather than at each call site.
 * `transport: 'external'` — see `gateways/content.audit.ts` for why owning the collection
 * did not make it transactional.
 */

/** The two ids a content audit row is worth searching by. */
function articleTarget(article: ArticleDocument): { id: string; label: string | null } {
    return { id: article.key, label: firstTitleOf(article) };
}

/**
 * A human-readable label so an audit feed reads without a cross-database join.
 *
 * The English title if there is one, otherwise the first translation's — a row saying
 * "Deleted an article: getting-paid-on-whatsapp" is worse than one that names the prose,
 * and an Arabic-only article should still read as something.
 */
function firstTitleOf(article: ArticleDocument): string | null {
    const english = article.translations.find((translation) => translation.locale === 'en');
    return (english ?? article.translations[0])?.title ?? null;
}

function authorTarget(author: ArticleAuthorDocument): { id: string; label: string | null } {
    return { id: author.key, label: author.name };
}

/**
 * What an audit row keeps about an article — not the whole document.
 *
 * A body is up to 400 blocks and the trail is read by people. The fields here are the ones
 * a `before`/`after` diff makes a sentence out of: what state it was in, who is credited,
 * and which URLs it answers to. `slug_keys` is in because a slug rename is the change most
 * worth being able to reconstruct months later — it is why the old URL still resolves.
 */
function articleState(article: ArticleDocument): Record<string, unknown> {
    return {
        status: article.status,
        categoryKey: article.category_key,
        authorId: article.author_key,
        featured: article.featured,
        publishedAt: article.published_at ? article.published_at.toISOString() : null,
        slugKeys: [...article.slug_keys],
    };
}

function authorState(author: ArticleAuthorDocument): Record<string, unknown> {
    return {
        name: author.name,
        type: author.type,
        locales: Object.keys(author.translations ?? {}),
    };
}

export class ContentArticleController {

    static search = asyncHandler(async (req: Request, res: Response) => {
        const query = req.query as unknown as SearchArticlesQuery;
        const { page, authorsByKey } = await articleService.list(query);

        sendPaginated(
            res,
            page.items.map((article) =>
                toAdminArticleSummaryDto(article, authorsByKey.get(article.author_key) ?? null)),
            { total: page.total, page: page.page, limit: page.limit, pages: page.pages },
        );
    });

    static get = asyncHandler(async (req: Request, res: Response) => {
        const { article, author } = await articleService.getByKey(req.params.articleKey);
        sendSuccess(res, toAdminArticleDto(article, author));
    });

    /**
     * The public detail shape, at any status.
     *
     * Deliberately the same projection a logged-out reader gets, so what an editor approves
     * is what ships. `read-models/public-article.dto.ts` explains why this exists rather
     * than a draft flag on jovi-mall's public route.
     */
    static preview = asyncHandler(async (req: Request, res: Response) => {
        const { locale } = req.query as unknown as PreviewQuery;
        const { article, translation } = await articleService.previewTranslation(req.params.articleKey, locale);
        const author = await articleService.resolveAuthor(article);

        sendSuccess(res, toPublicArticleDetailDto(article, translation, author));
    });

    static create = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as CreateArticleBody;

        const created = await auditedContentWrite(
            'content.articles.create',
            actorContextOf(req),
            { id: body.id, label: null },
            // The whole create body would put an article's entire prose in the audit row.
            { id: body.id, categoryKey: body.categoryKey, authorId: body.authorId },
            null,
            async () => {
                const article = await articleService.create(body, adminAuthorStampOf(identity));
                return { value: article, after: articleState(article) };
            },
        );

        const author = await articleService.resolveAuthor(created);
        sendCreated(res, toAdminArticleDto(created, author));
    });

    static update = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as UpdateArticleBody;
        const before = await articleService.requireArticle(req.params.articleKey);

        const updated = await auditedContentWrite(
            'content.articles.update',
            actorContextOf(req),
            articleTarget(before),
            // Which fields were touched, not what they were set to: `translations` alone is
            // the article. The `before`/`after` pair carries the part worth diffing.
            { fields: Object.keys(body) },
            articleState(before),
            async () => {
                const article = await articleService.update(
                    req.params.articleKey,
                    body,
                    adminAuthorStampOf(identity),
                );
                return { value: article, after: articleState(article) };
            },
        );

        const author = await articleService.resolveAuthor(updated);
        sendSuccess(res, toAdminArticleDto(updated, author));
    });

    static publish = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const body = req.body as PublishArticleBody;
        const before = await articleService.requireArticle(req.params.articleKey);

        const published = await auditedContentWrite(
            'content.articles.publish',
            actorContextOf(req),
            articleTarget(before),
            body.publishedAt ? { publishedAt: body.publishedAt.toISOString() } : null,
            articleState(before),
            async () => {
                const article = await articleService.publish(
                    req.params.articleKey,
                    body,
                    adminAuthorStampOf(identity),
                );
                return { value: article, after: articleState(article) };
            },
        );

        const author = await articleService.resolveAuthor(published);
        sendSuccess(res, toAdminArticleDto(published, author));
    });

    static unpublish = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const before = await articleService.requireArticle(req.params.articleKey);

        const updated = await auditedContentWrite(
            'content.articles.unpublish',
            actorContextOf(req),
            articleTarget(before),
            null,
            articleState(before),
            async () => {
                const article = await articleService.unpublish(
                    req.params.articleKey,
                    adminAuthorStampOf(identity),
                );
                return { value: article, after: articleState(article) };
            },
        );

        const author = await articleService.resolveAuthor(updated);
        sendSuccess(res, toAdminArticleDto(updated, author));
    });

    static archive = asyncHandler(async (req: Request, res: Response) => {
        const identity = requireAdminIdentity(req);
        const before = await articleService.requireArticle(req.params.articleKey);

        const updated = await auditedContentWrite(
            'content.articles.archive',
            actorContextOf(req),
            articleTarget(before),
            null,
            articleState(before),
            async () => {
                const article = await articleService.archive(
                    req.params.articleKey,
                    adminAuthorStampOf(identity),
                );
                return { value: article, after: articleState(article) };
            },
        );

        const author = await articleService.resolveAuthor(updated);
        sendSuccess(res, toAdminArticleDto(updated, author));
    });

    static remove = asyncHandler(async (req: Request, res: Response) => {
        const before = await articleService.requireArticle(req.params.articleKey);

        await auditedContentWrite(
            'content.articles.delete',
            actorContextOf(req),
            articleTarget(before),
            null,
            articleState(before),
            async () => {
                const article = await articleService.remove(req.params.articleKey);
                // `after` is null rather than the pre-delete state: the row is gone from
                // every live query, and repeating `before` would read as "nothing changed".
                return { value: article, after: null };
            },
        );

        sendSuccess(res, { id: before.key, deleted: true });
    });
}

export class ContentAuthorController {

    static list = asyncHandler(async (_req: Request, res: Response) => {
        const rows = await articleAuthorService.list();
        sendSuccess(res, rows.map(({ author, articleCount }) => toAdminArticleAuthorDto(author, articleCount)));
    });

    static get = asyncHandler(async (req: Request, res: Response) => {
        const { author, articleCount } = await articleAuthorService.getByKey(req.params.authorKey);
        sendSuccess(res, toAdminArticleAuthorDto(author, articleCount));
    });

    static create = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as CreateAuthorBody;

        const created = await auditedContentWrite(
            'content.authors.create',
            actorContextOf(req),
            { id: body.id, label: body.name },
            { id: body.id, name: body.name, type: body.type },
            null,
            async () => {
                const { author } = await articleAuthorService.create(body);
                return { value: author, after: authorState(author) };
            },
        );

        sendCreated(res, toAdminArticleAuthorDto(created, 0));
    });

    static update = asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as UpdateAuthorBody;
        const { author: before } = await articleAuthorService.getByKey(req.params.authorKey);

        const result = await auditedContentWrite(
            'content.authors.update',
            actorContextOf(req),
            authorTarget(before),
            { fields: Object.keys(body) },
            authorState(before),
            async () => {
                const updated = await articleAuthorService.update(req.params.authorKey, body);
                return { value: updated, after: authorState(updated.author) };
            },
        );

        sendSuccess(res, toAdminArticleAuthorDto(result.author, result.articleCount));
    });

    static remove = asyncHandler(async (req: Request, res: Response) => {
        const { author: before } = await articleAuthorService.getByKey(req.params.authorKey);

        await auditedContentWrite(
            'content.authors.delete',
            actorContextOf(req),
            authorTarget(before),
            null,
            authorState(before),
            async () => {
                const author = await articleAuthorService.remove(req.params.authorKey);
                return { value: author, after: null };
            },
        );

        sendSuccess(res, { id: before.key, deleted: true });
    });
}

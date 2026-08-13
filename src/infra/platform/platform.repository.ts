import { Collection, Document, Filter, FindOptions, Sort } from 'mongodb';
import { platformConnection } from '../mongo/connections';
import { createAppError } from '../../core/errors/app-error';
import { ERROR_CODES } from '../../core/errors/error-codes';
import { toPageMeta } from '../../core/http/list-query';
import { OwnedCollection, PlatformCollection } from './platform-collections';

/**
 * Reading the shared `jovi_mall` database.
 *
 * ── Why the raw driver and not Mongoose (ADR-004 D-3) ─────────────────────────
 * jovi-mall exports no schemas — zero `export const *Schema`, only compiled Models, and
 * importing one registers it on THIS process's default connection and drags in module
 * config that throws at load time. Redeclaring the ~15 schemas here would create a second
 * definition per collection that must be kept in step by hand, for the benefit of casting
 * we do not need on a read path.
 *
 * So: `platformConnection().db.collection(name)`, hand-written read-model interfaces, and
 * an explicit projection per repository. No schema to drift, no validation two processes
 * must agree on, and nothing that can be `.save()`d by accident.
 *
 * ── Why this base class exists at all ─────────────────────────────────────────
 * It is not a wrapper for the sake of layering. It is the mechanism that makes ADR-004's
 * read-only rule structural: **there is no write method to call.** A service holding one
 * of these cannot insert, update or delete however carelessly it is written, and no code
 * review has to catch it.
 *
 * The projection lives here rather than at the call site for the same reason. A field that
 * should never leave the database — `password_hash`, `mfa_secret` — leaves it exactly once,
 * from the one query somebody wrote in a hurry.
 */

export interface Paginated<T> {
    items: T[];
    total: number;
    page: number;
    limit: number;
    pages: number;
}

export interface PageRequest {
    page: number;
    limit: number;
    sort?: Sort;
}

export abstract class PlatformReadRepository<T extends Document> {
    /**
     * @param collectionName typed to the access table, so a repository cannot be pointed
     *        at a collection nobody decided this service may touch.
     * @param projection the ONLY fields that leave the database. Required, not optional:
     *        an omitted projection returns whole documents, which is how a credential ends
     *        up in a response.
     */
    protected constructor(
        private readonly collectionName: PlatformCollection,
        protected readonly projection: Document,
    ) {}

    /**
     * Resolved per call rather than cached. `platformConnection()` throws a 503 until
     * `connectAll()` has run, and holding a reference from construction time would capture
     * that failure permanently instead of reporting it per request.
     */
    protected collection(): Collection<T> {
        // `Connection.db` is optional in Mongoose's types because a connection may not
        // have handshaken yet. `platformConnection()` already throws 503 in that case, so
        // reaching here with no db would be a bug in the accessor, not a caller error.
        const db = platformConnection().db;
        if (!db) {
            throw createAppError(
                ERROR_CODES.SERVICE_DEPENDENCY_UNAVAILABLE,
                503,
                'The platform database connection is not ready',
            );
        }
        return db.collection<T>(this.collectionName);
    }

    protected async findOneBy(filter: Filter<T>): Promise<T | null> {
        // The driver returns `WithId<T>`, which only adds `_id`. Every read model here
        // declares its own `_id`, so the cast narrows rather than widens.
        const found = await this.collection().findOne(filter, { projection: this.projection } as FindOptions);
        return (found as T | null) ?? null;
    }

    protected async findBy(filter: Filter<T>, options: FindOptions = {}): Promise<T[]> {
        return this.collection()
            .find(filter, { projection: this.projection, ...options })
            .toArray() as unknown as Promise<T[]>;
    }

    /**
     * A page of results plus the total.
     *
     * `countDocuments` runs alongside rather than after — two round trips either way, and
     * a list screen needs both before it can render.
     */
    protected async findPage(filter: Filter<T>, page: PageRequest): Promise<Paginated<T>> {
        const skip = (page.page - 1) * page.limit;

        const [items, total] = await Promise.all([
            this.collection()
                .find(filter, { projection: this.projection })
                .sort(page.sort ?? { _id: -1 })
                .skip(skip)
                .limit(page.limit)
                .toArray() as unknown as Promise<T[]>,
            this.collection().countDocuments(filter),
        ]);

        // `toPageMeta` rather than the arithmetic inline: this method used to compute
        // `Math.max(1, ceil(...))` while both list controllers computed a bare `ceil`, so an
        // empty result reported one page here and zero pages there. One formula, one answer
        // — and it is the platform's (`jovi-mall/api-doc/README.md`): empty means 0 pages.
        return { items, ...toPageMeta(total, page.page, page.limit) };
    }

    protected async countBy(filter: Filter<T>): Promise<number> {
        return this.collection().countDocuments(filter);
    }

    /**
     * For read models a single query cannot express — a join onto another collection, or a
     * grouped total.
     *
     * Deliberately not a general escape hatch: an aggregation that WRITES (`$out`,
     * `$merge`) would bypass the whole rule, so those stages are refused here rather than
     * trusted not to appear.
     */
    protected async aggregateBy<R extends Document>(pipeline: Document[]): Promise<R[]> {
        assertReadOnlyPipeline(pipeline);
        return this.collection().aggregate<R>(pipeline).toArray();
    }

    /**
     * A page from an aggregation, with the projection applied by the BASE rather than by
     * the caller.
     *
     * ── Why this exists ───────────────────────────────────────────────────────────
     * `findPage`'s guarantee — stated at the constructor, "there is no way to run a query
     * without the projection" — did not survive `aggregateBy`, which passes the pipeline
     * straight through and applies nothing. Every read model up to now was a single
     * collection, so nobody walked through the hole; the delivery-agency list is the first
     * one needing a `$lookup`. Rather than have that one caller remember its own
     * `$project`, the guarantee is restored here, where the next joined domain inherits it.
     *
     * The caller supplies the stages; this method appends the projection and the paging.
     *
     * ── The two stage lists, and why the split is worth the extra parameter ───────
     * `match` runs first, on the raw collection, where an index can still serve the
     * `$sort` the base appends. `join` runs INSIDE the items branch, after skip/limit —
     * so a `$lookup` touches at most `limit` documents instead of the whole matched set.
     *
     * The exception is a query that must filter or sort ON a joined field (searching
     * agencies by their Magazin's business name). That cannot be paged first, so such a
     * caller puts its `$lookup` in `match` and accepts the blocking sort — deliberately,
     * and with the reason written at the call site.
     *
     * `project` may only ADD named fields (the joined sub-document). The base's own
     * projection is spread first and cannot be removed, and an exclusion is refused rather
     * than merged: `{ x: 0 }` next to inclusions is either a driver error or, for `_id`, a
     * silent change of shape.
     */
    protected async aggregatePage<R extends Document>(
        page: PageRequest,
        spec: { match: Document[]; join?: Document[]; project?: Document },
    ): Promise<Paginated<R>> {
        const join = spec.join ?? [];
        assertReadOnlyPipeline([...spec.match, ...join]);
        assertInclusionOnly(spec.project);

        const skip = (page.page - 1) * page.limit;
        const projection: Document = { ...this.projection, ...spec.project };

        const [facet] = await this.collection()
            .aggregate<{ items: R[]; total: { value: number }[] }>([
                ...spec.match,
                {
                    $facet: {
                        items: [
                            // `_id` is appended by `toMongoSort` for every caller, so the
                            // fallback here is only reached by a caller that passed no sort
                            // at all — same default as `findPage`, deliberately.
                            { $sort: page.sort ?? { _id: -1 } },
                            { $skip: skip },
                            { $limit: page.limit },
                            ...join,
                            { $project: projection },
                        ],
                        total: [{ $count: 'value' }],
                    },
                },
            ])
            .toArray();

        // An empty collection produces `total: []`, not `total: [{ value: 0 }]` — `$count`
        // emits no document when nothing reaches it. Reading `[0].value` unguarded is how
        // an empty list becomes a TypeError instead of a page.
        const total = facet?.total?.[0]?.value ?? 0;
        return { items: facet?.items ?? [], ...toPageMeta(total, page.page, page.limit) };
    }

    /**
     * One document from an aggregation — `findOneBy`'s counterpart for a read model that
     * needs a join.
     *
     * The same guarantee as `aggregatePage`, and it exists for the same reason: a detail
     * screen usually wants MORE fields than its list, and letting the caller supply the
     * whole `$project` to get them puts the whitelist back in the place this base class
     * exists to take it out of.
     *
     * `project` may only ADD. A domain whose detail is genuinely wider than its list gives
     * this base the narrow list projection at construction — so the default is the safe one
     * — and names the extra fields here, where they are a visible diff.
     */
    protected async aggregateOne<R extends Document>(
        stages: Document[],
        project?: Document,
    ): Promise<R | null> {
        assertReadOnlyPipeline(stages);
        assertInclusionOnly(project);

        const [found] = await this.collection()
            .aggregate<R>([...stages, { $project: { ...this.projection, ...project } }, { $limit: 1 }])
            .toArray();
        return found ?? null;
    }
}

/**
 * A pipeline that writes bypasses ADR-004 D-2 entirely, so the two write stages are
 * refused here rather than trusted not to appear.
 */
function assertReadOnlyPipeline(pipeline: Document[]): void {
    const writeStage = pipeline.find((stage) => '$out' in stage || '$merge' in stage);
    if (writeStage) {
        throw new RangeError(
            'A platform read repository may not run $out or $merge — that is a write. '
            + 'See ADR-004 D-2: platform writes go through jovi-mall.',
        );
    }
}

/**
 * The caller's extra projection may only add fields. See `aggregatePage`.
 *
 * ── Why this recurses, and what it cost to learn ──────────────────────────────
 * It checked only the top level until Phase 11, and the gap was not theoretical: the agency
 * directory and detail both passed `{ magazin: MAGAZIN_PROJECTION }`, whose NESTED `_id: 0`
 * is an exclusion inside an inclusion projection. Mongo refuses that outright, so both
 * endpoints answered 500 on every request from Phase 9 until an accounts route happened to
 * read an agency through the same repository.
 *
 * A top-level-only check could not see it, and no DB-free suite could either — the shape is
 * legal TypeScript, legal JSON, and only illegal to `$project`. So the guard now walks the
 * whole object and refuses an exclusion at any depth, which turns the next one into a
 * RangeError naming the path instead of a 500 naming nothing.
 *
 * Note this is stricter than Mongo: a nested `_id: 0` is legal in a `$lookup`'s own inner
 * pipeline. That stage does not come through here — only the OUTER projection does, where
 * the exclusion is always wrong.
 */
export function assertInclusionOnly(projection: Document | undefined, path = ''): void {
    if (!projection) return;

    for (const [field, value] of Object.entries(projection)) {
        const fullPath = path ? `${path}.${field}` : field;

        if (value === 0 || value === false) {
            throw new RangeError(
                `aggregatePage: \`${fullPath}\` is an exclusion. The extra projection may only `
                + 'ADD named fields to the repository\'s own whitelist, never remove one. '
                + 'To keep a joined sub-document, name it (`{ joined: 1 }`) and let the '
                + '$lookup\'s own $project be its whitelist.',
            );
        }

        // A nested object is a sub-document projection spec, and an exclusion inside one is
        // refused by Mongo exactly as a top-level exclusion is.
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            assertInclusionOnly(value as Document, fullPath);
        }
    }
}

/**
 * Reading AND writing a collection this service owns outright.
 *
 * The type parameter accepts only collections marked `access: 'owned'` in the access
 * table, so `class UserRepo extends PlatformOwnedRepository<'users', …>` does not compile.
 * That is the enforcement — there is no runtime check because there is no runtime path to
 * check.
 *
 * Exactly two collections qualify today: `articles` and `article_authors`, whose ownership
 * moved here in Phase 4 because jovi-mall retains no writer for them (ADR-004 D-4). Adding
 * a third means changing the access table, which is a diff worth reading.
 */
export abstract class PlatformOwnedRepository<
    C extends OwnedCollection,
    T extends Document,
> extends PlatformReadRepository<T> {
    protected constructor(collectionName: C, projection: Document) {
        super(collectionName, projection);
    }

    protected async insertOneDoc(doc: T): Promise<string> {
        const result = await this.collection().insertOne(doc as never);
        return result.insertedId.toString();
    }

    protected async updateOneBy(filter: Filter<T>, update: Document): Promise<boolean> {
        const result = await this.collection().updateOne(filter, update);
        return result.matchedCount > 0;
    }

    protected async deleteOneBy(filter: Filter<T>): Promise<boolean> {
        const result = await this.collection().deleteOne(filter);
        return result.deletedCount > 0;
    }
}

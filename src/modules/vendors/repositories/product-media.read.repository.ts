import { Document, Filter, ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { COLLECTIONS } from '../../../infra/platform/collections';
import { PlatformReadRepository } from '../../../infra/platform/platform.repository';
import { FileDetail, toFileDetail } from '../../../infra/storage/file-detail';

/**
 * What the thing being sold looks like — one picture per `(product, variant)` pair.
 *
 * ── Why it lives in the VENDORS module and is read from two others (BR-017) ───
 * `products` is this module's collection, and the rule the shipments controller states in
 * the other direction applies here: the module that owns the collection owns the read. The
 * order detail and the shipment detail both need it, and two copies of a media-resolution
 * rule is exactly the drift that would show one picture on one screen and another on the
 * next.
 *
 * ── A deliberate mirror of jovi-mall's `resolveProductImages` ────────────────
 *   source: jovi-mall/src/modules/catalog/read-models/product-image.resolver.ts
 *
 * Three properties are copied rather than reinvented, because a client comparing this
 * screen with the customer's own order page must see the same picture:
 *
 *   1. **Variant first, product second — as a FALLBACK, not a merge.** The variant is the
 *      sellable unit, so its own media is the truthful picture of what is in the box: a red
 *      T-shirt must not show the blue one. Appending the product's shots after the
 *      variant's would reintroduce the wrong colour halfway down the gallery.
 *   2. **Only `image/*` qualifies.** `fileIds` is generic media and legitimately holds a
 *      video or a spec sheet; the first entry is the thumbnail *by convention*, not by
 *      type. A video's URL rendered into an `<img>` is a broken thumbnail.
 *   3. **Resolved live, never snapshotted.** An order item snapshots title, sku and price
 *      because those are the terms of the sale; an image is not a term of the sale, it is
 *      an aid to recognising the object, so the CURRENT picture is the more useful one —
 *      and every order that already exists gets one with no backfill.
 *
 * ── Soft deletes: files YES, products and variants NO ────────────────────────
 * `files` is filtered on `deletedAt: null`, matching jovi-mall's `findManyByIds`, which is
 * what makes a swept file resolve to no image rather than to a dead URL.
 *
 * Products and variants are deliberately NOT filtered, and that is a considered departure
 * from `buildProductFilter`'s emphatic `deletedAt: null` rule rather than a lapse. That
 * rule protects a LISTING — a soft-deleted product on an administrative directory is a
 * listing an operator might suspend, reinstate or count. This is not a listing: the order
 * line already names the product, and the only question is what it looked like. jovi-mall
 * applies no filter here either, so filtering would make an administrator investigating a
 * dispute see a blank where the customer looking at the same order sees a photograph.
 */

/** One thing to find a picture of: the variant that was sold, and its product. */
export interface ProductImageRef {
    productId: string | null;
    /** `null` on a line that names no variant — a legacy order item, or a shipment row. */
    variantId: string | null;
}

/** Map key for a `(product, variant)` pair. Use it on both sides of the lookup. */
export function productImageKey(productId: string | null, variantId: string | null): string {
    return `${productId ?? ''}:${variantId ?? ''}`;
}

/**
 * `products` and `product_variants` store their fields in **camelCase**, unlike every other
 * collection this service reads. That is jovi-mall's catalogue convention, not a slip — see
 * `vendor-product.read.repository.ts`, whose projection names `vendorId` and `createdAt`.
 */
interface MediaOwnerReadModel extends Document {
    _id: ObjectId;
    fileIds?: ObjectId[];
}

/**
 * The gallery slot, on whichever of the two collections holds it.
 *
 * One base rather than two near-identical classes: the two differ in nothing but the
 * collection name, and the fallback rule below depends on them answering in exactly the
 * same shape.
 */
abstract class MediaOwnerRepository extends PlatformReadRepository<MediaOwnerReadModel> {
    protected constructor(collection: typeof COLLECTIONS.PRODUCT | typeof COLLECTIONS.PRODUCT_VARIANT) {
        super(collection, { _id: 1, fileIds: 1 });
    }

    async fileIdsByOwner(ids: ObjectId[]): Promise<Map<string, string[]>> {
        if (ids.length === 0) return new Map();

        const rows = await this.findBy({ _id: { $in: ids } } as Filter<MediaOwnerReadModel>, {
            limit: ids.length,
        });

        return new Map(
            rows.map((row) => [row._id.toString(), (row.fileIds ?? []).map((id) => id.toString())]),
        );
    }
}

class ProductMediaOwnerRepository extends MediaOwnerRepository {
    constructor() { super(COLLECTIONS.PRODUCT); }
}

class VariantMediaOwnerRepository extends MediaOwnerRepository {
    constructor() { super(COLLECTIONS.PRODUCT_VARIANT); }
}

/**
 * A stored file row, narrowed to what `toFileDetail` consumes.
 *
 * `provider` is NOT projected and is not consulted: `buildPublicUrl` reads this
 * deployment's `STORAGE_PROVIDER`, exactly as jovi-mall's own resolver reads
 * `getStorageProvider()` rather than the row's column. A row whose stored `provider`
 * disagrees with the configured one is a migration artefact, and honouring it here would
 * make this service build a URL for a bucket it is not pointed at.
 */
interface StoredFileReadModel extends Document {
    _id: ObjectId;
    key: string;
    mimeType: string;
    size: number;
    originalName?: string | null;
    /**
     * Written by jovi-mall's plan-quota sweep when the vendor is over their storage cap and
     * this file falls outside it. Read so `toFileDetail` reports `quota_blocked` rather than
     * a URL jovi-mall no longer serves — an omitted column reads as "not blocked", so leaving
     * it unprojected is a silent leak rather than a compile error.
     */
    quotaBlockedAt?: Date | null;
}

class ProductFileReadRepository extends PlatformReadRepository<StoredFileReadModel> {
    constructor() {
        super(COLLECTIONS.FILE, { _id: 1, key: 1, mimeType: 1, size: 1, originalName: 1, quotaBlockedAt: 1 });
    }

    /**
     * One query for every candidate across every ref — the point of a batch resolver.
     *
     * `deletedAt: null` mirrors jovi-mall's `FileRepositoryMongo.findManyByIds`. This
     * service reads with the raw driver, where nothing applies it automatically.
     */
    async findDetailsByIds(ids: ObjectId[]): Promise<Map<string, FileDetail>> {
        if (ids.length === 0) return new Map();

        const rows = await this.findBy(
            { _id: { $in: ids }, deletedAt: null } as Filter<StoredFileReadModel>,
            { limit: ids.length },
        );

        return new Map(
            rows.map((row) => [
                row._id.toString(),
                toFileDetail({
                    id: row._id.toString(),
                    key: row.key,
                    mimeType: row.mimeType,
                    size: row.size,
                    originalName: row.originalName,
                    quotaBlockedAt: row.quotaBlockedAt ?? null,
                }),
            ]),
        );
    }
}

/**
 * The facade the order and shipment details actually call.
 *
 * Three collections, three round trips regardless of how many lines the screen has —
 * never one lookup per row. That is the whole reason BR-017 was granted rather than left
 * to the client, whose only alternative was one delegated product read per distinct
 * product on the page.
 */
export class ProductMediaReadRepository {
    private readonly products = new ProductMediaOwnerRepository();
    private readonly variants = new VariantMediaOwnerRepository();
    private readonly files = new ProductFileReadRepository();

    /**
     * The PRIMARY image per `(product, variant)` pair — never the gallery.
     *
     * An items table wants one picture per line. Returning the whole gallery here would
     * put four images on every row of a twelve-line order for a screen that renders one,
     * and `GET /vendors/:vendorId/products/:productId` already serves the gallery to the
     * screen that wants it.
     *
     * A pair with no usable image is ABSENT from the map — read it as `map.get(key) ?? null`.
     * That is the ordinary answer for a digital line, a product whose media was swept, and
     * a variant that never had a picture, not a fault.
     */
    async primaryImages(refs: ProductImageRef[]): Promise<Map<string, FileDetail>> {
        const result = new Map<string, FileDetail>();
        if (refs.length === 0) return result;

        const productIds = uniqueObjectIds(refs.map((ref) => ref.productId));
        const variantIds = uniqueObjectIds(refs.map((ref) => ref.variantId));

        const [productFileIds, variantFileIds] = await Promise.all([
            this.products.fileIdsByOwner(productIds),
            this.variants.fileIdsByOwner(variantIds),
        ]);

        const candidates = new Set<string>();
        for (const ids of productFileIds.values()) for (const id of ids) candidates.add(id);
        for (const ids of variantFileIds.values()) for (const id of ids) candidates.add(id);

        const fileById = await this.files.findDetailsByIds(uniqueObjectIds([...candidates]));

        const imagesOf = (fileIds: string[] | undefined): FileDetail[] =>
            (fileIds ?? [])
                .map((id) => fileById.get(id))
                // `mimeType` decides, not the position: `fileIds[0]` is the thumbnail by
                // convention only, and a product whose first slot holds a video would
                // otherwise put a broken image on the line.
                .filter((file): file is FileDetail => file !== undefined && file.mimeType.startsWith('image/'));

        for (const ref of refs) {
            const variantImages = ref.variantId ? imagesOf(variantFileIds.get(ref.variantId)) : [];
            // Fallback, never a merge — see the header. `length > 0` is the test, so a
            // variant carrying only a spec sheet falls through to the product's photos
            // rather than resolving to nothing.
            const images = variantImages.length > 0
                ? variantImages
                : imagesOf(ref.productId ? productFileIds.get(ref.productId) : undefined);

            const primary = images[0];
            if (primary) result.set(productImageKey(ref.productId, ref.variantId), primary);
        }

        return result;
    }
}

/** Distinct, valid ObjectIds. A malformed id matches nothing and must not reach the driver. */
function uniqueObjectIds(values: (string | null | undefined)[]): ObjectId[] {
    const seen = new Set<string>();
    for (const value of values) {
        if (value && Types.ObjectId.isValid(value) && value.length === 24) seen.add(value);
    }
    return [...seen].map((id) => new ObjectId(id));
}

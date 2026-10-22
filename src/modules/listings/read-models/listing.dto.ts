import { ObjectId } from 'mongodb';
import { FileDetail } from '../../../infra/storage/file-detail';
import type { ListingVendorReadModel } from '../repositories/listing-context.read.repository';
import type { ListingContentReadModel, ListingReadModel } from '../repositories/listing.read.repository';

/**
 * The wire shapes of `/api/v1/listings` and `/api/v1/listings/:listingId` (ADR-005: camelCase,
 * ids as 24-hex strings, ISO-8601 instants, an absent value is `null` — never an omitted key).
 *
 * ⛔ **No contact value appears in any shape in this file**, and none could: the read models
 * these map from are projections of `listings` and `vendors` that carry none. The hidden
 * contacts have their own DTO (`listing-contacts.dto.ts`) behind their own permission and an
 * audit row. `availableFields` names WHICH fields the live copy has — names, never values.
 *
 * Named-field mapping, never a spread: the projection is the first lock, this is the second.
 */

export interface CategoryRef {
    id: string;
    name: string | null;
    slug: string | null;
}

export interface ActorRefDto {
    id: string | null;
    source: string;
    name: string | null;
}

export type ListingAction = 'approve' | 'reject' | 'suspend' | 'unsuspend';

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toActor(id: ObjectId | null | undefined, source: string | undefined, name: string | null | undefined): ActorRefDto {
    return { id: id?.toString() ?? null, source: source ?? 'platform', name: name ?? null };
}

/** § C-1: a vendor with no `kind` is a seller — there was no backfill. */
export function vendorKindOf(vendor: Pick<ListingVendorReadModel, 'kind'> | null | undefined): 'seller' | 'provider' {
    return vendor?.kind === 'provider' ? 'provider' : 'seller';
}

/**
 * The copy a queue row describes: the one under review if one is waiting, else the live copy,
 * else the draft. A live listing being revised therefore shows its NEW title in the queue —
 * which is what the reviewer is about to judge.
 */
export function copyUnderReview(row: Pick<ListingReadModel, 'review' | 'published' | 'pending'>): ListingContentReadModel | null {
    if (row.review?.state === 'pending_review' && row.pending) return row.pending;
    return row.published ?? row.pending ?? null;
}

/**
 * Which verbs make sense for this listing RIGHT NOW, from its state alone. Whether THIS
 * administrator may use them is their permissions' question; a screen needs both. jovi-mall
 * remains the judge — a stale screen gets its `409 LISTING_STATUS_CONFLICT` through.
 *
 * `unsuspend` only for `platform_oversight`: the other two reasons are lifted by a top-up and
 * by the plan-quota sweep, never by an administrator.
 */
export function availableActionsOf(row: Pick<ListingReadModel, 'status' | 'review' | 'suspension'>): ListingAction[] {
    const actions: ListingAction[] = [];
    if (row.review?.state === 'pending_review') actions.push('approve', 'reject');
    if (row.status === 'live') actions.push('suspend');
    if (row.status === 'suspended' && row.suspension?.reason === 'platform_oversight') actions.push('unsuspend');
    return actions;
}

// ─── The queue row ───────────────────────────────────────────────────────────

export interface ListingVendorRefDto {
    id: string;
    displayName: string | null;
}

export interface ListingQueueItemDto {
    id: string;
    slug: string;
    status: string;
    reviewState: string | null;
    /** True when a live listing carries an edit under way — the queue row is a REVISION. */
    isRevision: boolean;
    title: string | null;
    companyName: string | null;
    city: string | null;
    submittedAt: string | null;
    preflagCount: number;
    suspensionReason: string | null;
    vendor: ListingVendorRefDto;
    publishedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export function toListingQueueItemDto(
    row: ListingReadModel,
    vendor: ListingVendorReadModel | undefined,
): ListingQueueItemDto {
    const copy = copyUnderReview(row);
    return {
        id: row._id.toString(),
        slug: row.slug,
        status: row.status,
        reviewState: row.review?.state ?? null,
        isRevision: Boolean(row.published) && Boolean(row.pending),
        title: copy?.title || null,
        companyName: copy?.company_name || null,
        city: copy?.city || null,
        submittedAt: toIso(row.review?.submitted_at),
        preflagCount: row.review?.preflags?.length ?? 0,
        suspensionReason: row.suspension?.reason ?? null,
        vendor: { id: row.vendor_id.toString(), displayName: vendor?.display_name ?? null },
        publishedAt: toIso(row.published_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}

// ─── The detail ──────────────────────────────────────────────────────────────

export interface ListingContentDto {
    title: string | null;
    companyName: string | null;
    categories: CategoryRef[];
    country: string | null;
    city: string | null;
    area: string | null;
    description: string | null;
    descriptionRich: unknown;
    photos: FileDetail[];
    openingHours: Array<{ day: string | null; openTime: string | null; closeTime: string | null; isClosed: boolean }> | null;
}

/** Everything the detail needs from outside `listings`, resolved once by the caller. */
export interface ListingDetailContext {
    vendor: ListingVendorReadModel | undefined;
    categories: Map<string, { id: string; name: string; slug: string }>;
    files: Map<string, FileDetail>;
    counts: { leads: number; reveals: number };
}

/**
 * A category the list no longer holds (merged away or deleted) still appears, by id, with a
 * `null` name — a reviewer should see that the listing points at something gone rather than
 * see one category fewer.
 */
function toContentDto(content: ListingContentReadModel | null | undefined, ctx: ListingDetailContext): ListingContentDto | null {
    if (!content) return null;
    return {
        title: content.title || null,
        companyName: content.company_name || null,
        categories: (content.category_ids ?? []).map((id) => {
            const found = ctx.categories.get(id.toString());
            return { id: id.toString(), name: found?.name ?? null, slug: found?.slug ?? null };
        }),
        country: content.country || null,
        city: content.city || null,
        area: content.area || null,
        description: content.description || null,
        descriptionRich: content.description_rich ?? null,
        /** In the provider's order; a swept file drops out rather than rendering as a dead image. */
        photos: (content.photo_file_ids ?? [])
            .map((id) => ctx.files.get(id.toString()))
            .filter((file): file is FileDetail => file !== undefined),
        openingHours: content.opening_hours
            ? content.opening_hours.map((h) => ({
                day: h.day ?? null,
                openTime: h.open_time ?? null,
                closeTime: h.close_time ?? null,
                isClosed: h.is_closed === true,
            }))
            : null,
    };
}

export interface ListingVendorSummaryDto {
    id: string;
    displayName: string | null;
    status: string | null;
    kind: 'seller' | 'provider';
    kycStatus: string;
    verified: boolean;
}

function toVendorSummary(vendorId: ObjectId, vendor: ListingVendorReadModel | undefined): ListingVendorSummaryDto {
    return {
        id: vendorId.toString(),
        displayName: vendor?.display_name ?? null,
        status: vendor?.status ?? null,
        kind: vendorKindOf(vendor),
        // Rows written before the verdict existed carry no status; `pending` is what they mean.
        kycStatus: vendor?.kyc_details?.status ?? 'pending',
        verified: vendor?.kyc_details?.legit_verified === true,
    };
}

export function toListingDetailDto(row: ListingReadModel, ctx: ListingDetailContext) {
    const review = row.review
        ? {
            state: row.review.state ?? null,
            submittedAt: toIso(row.review.submitted_at),
            decidedAt: toIso(row.review.decided_at),
            decidedBy: row.review.decided_at
                ? toActor(row.review.decided_by_user_id, row.review.decided_by_source, row.review.decided_by_name)
                : null,
            reasons: row.review.reasons ?? [],
            /** Help for the reviewer, never a decision (O-15): text found in the public copy. */
            preflags: (row.review.preflags ?? []).map((p) => ({
                kind: p.kind ?? null,
                field: p.field ?? null,
                excerpt: p.excerpt ?? null,
            })),
            /** The ledger row of the indexing fee taken at submission (O-18), refunded on reject. */
            indexFeeRef: row.review.index_fee_ref ?? null,
        }
        : null;

    const lastDecision = row.last_decision
        ? {
            decision: row.last_decision.decision ?? null,
            at: toIso(row.last_decision.at),
            by: toActor(row.last_decision.by_user_id, row.last_decision.by_source, row.last_decision.by_name),
            reasons: row.last_decision.reasons ?? [],
        }
        : null;

    const suspension = row.suspension
        ? {
            reason: row.suspension.reason ?? null,
            previousStatus: row.suspension.previous_status ?? null,
            at: toIso(row.suspension.at),
            note: row.suspension.note ?? null,
            by: toActor(row.suspension.by_user_id, row.suspension.by_source, row.suspension.by_name),
        }
        : null;

    return {
        id: row._id.toString(),
        slug: row.slug,
        status: row.status,
        vendor: toVendorSummary(row.vendor_id, ctx.vendor),
        published: toContentDto(row.published, ctx),
        pending: toContentDto(row.pending, ctx),
        isRevision: Boolean(row.published) && Boolean(row.pending),
        review,
        lastDecision,
        suspension,
        availableFields: row.available_fields ?? [],
        counts: { leads: ctx.counts.leads, reveals: ctx.counts.reveals },
        availableActions: availableActionsOf(row),
        vectorisationStatus: row.vectorisation_status ?? null,
        publishedAt: toIso(row.published_at),
        archivedAt: toIso(row.archived_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}
export type ListingDetailDto = ReturnType<typeof toListingDetailDto>;

/** Category and photo ids across BOTH copies, so the caller resolves them in one query each. */
export function referencedIdsOf(row: Pick<ListingReadModel, 'published' | 'pending'>): { categoryIds: ObjectId[]; fileIds: ObjectId[] } {
    const categories = new Map<string, ObjectId>();
    const files = new Map<string, ObjectId>();
    for (const copy of [row.published, row.pending]) {
        for (const id of copy?.category_ids ?? []) categories.set(id.toString(), id);
        for (const id of copy?.photo_file_ids ?? []) files.set(id.toString(), id);
    }
    return { categoryIds: [...categories.values()], fileIds: [...files.values()] };
}

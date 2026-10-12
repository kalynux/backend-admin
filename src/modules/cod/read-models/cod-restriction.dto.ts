/**
 * An administrator's cash-on-delivery restriction on one account, as this API reports it.
 *
 * ── What it is ───────────────────────────────────────────────────────────────
 * Owner decision, 2026-10-10: an administrator may switch cash on delivery OFF for one
 * CUSTOMER or one delivery AGENCY, and back on. jovi-mall keeps it as one sub-document on
 * the role entity — `customers.cod_restriction` and `delivery_agencies.cod_restriction`,
 * the same stored shape on both — and enforces it. Nothing recorded means not restricted,
 * which is the state of every document written before the field existed.
 *
 * ── Why one file, here ───────────────────────────────────────────────────────
 * Two direct reads project the field: the agency detail and the customer profile on the
 * user detail. They read the same stored shape, so they share one mapper rather than each
 * growing a copy that could disagree about what "restricted" means. The two gateways share
 * the delegated report below for the same reason. It all sits in the COD module because the
 * rule is a COD rule; neither the agency nor the user module owns it.
 *
 * ── Read-only, and it decides nothing ────────────────────────────────────────
 * This is the record, for a badge on a screen. Whether a given order or shipment may use
 * cash on delivery is a verdict jovi-mall reaches at checkout and at every hand-off, and it
 * is never re-derived here. The writes are delegated (`PUT …/cod-restriction` and
 * `POST …/cod-restriction/lift` on both mounts); this service never writes the field.
 *
 * ⚠ The `reason` is the administrator's. jovi-mall never shows it to the restricted party,
 * and nothing built on this DTO may either.
 */

/** jovi-mall's `ICodRestriction`, as much of it as a projection can return. */
export interface StoredCodRestriction {
    reason?: string | null;
    restricted_at?: Date | string | null;
    /** A string, not an ObjectId: it is the acting administrator's id, which resolves here. */
    restricted_by_user_id?: string | null;
    restricted_by_source?: string | null;
    restricted_by_name?: string | null;
}

export interface CodRestrictionDto {
    reason: string;
    /** ISO-8601. */
    restrictedAt: string;
    restrictedByUserId: string | null;
    /** `admin` for a restriction set through this service. */
    restrictedBySource: string;
    restrictedByName: string | null;
}

/**
 * `null` when the account is not restricted.
 *
 * The test is jovi-mall's own (`isCodRestricted` in its `cod/domain/cod-restriction.ts`):
 * a restriction exists when `restricted_at` is set. An absent field, an explicit `null` and
 * a sub-document without the stamp all read as NOT restricted, so this DTO and the
 * delegated `GET …/cod-restriction` cannot disagree about the same document.
 *
 * Named fields, not a spread — a field jovi-mall adds to the sub-document later does not
 * reach the wire until someone names it here.
 */
export function toCodRestrictionDto(stored: unknown): CodRestrictionDto | null {
    if (!stored || typeof stored !== 'object') return null;

    const restriction = stored as StoredCodRestriction;
    const at = restriction.restricted_at;
    if (at === null || at === undefined) return null;

    return {
        reason: restriction.reason ?? '',
        restrictedAt: at instanceof Date ? at.toISOString() : new Date(at).toISOString(),
        restrictedByUserId: restriction.restricted_by_user_id ?? null,
        restrictedBySource: restriction.restricted_by_source ?? 'platform',
        restrictedByName: restriction.restricted_by_name ?? null,
    };
}

// ─── The delegated report ─────────────────────────────────────────────────────

/**
 * jovi-mall's `CodRestrictionReport` — what `GET` and `PUT …/cod-restriction` answer on
 * both of its mounts (`/users/:userId` and `/agencies/:id`), and what this service's six
 * routes answer in turn.
 *
 * `subjectId` is the ROLE ENTITY's id (`customers._id` or `delivery_agencies._id`), and
 * `userId` the owning `users._id`. On the customer mount the path names the user, so the
 * two differ; on the agency mount the path names the agency, so `subjectId` is the path id.
 */
export interface CodRestrictionReport {
    subject: 'customer' | 'agency';
    subjectId: string;
    userId: string | null;
    restricted: boolean;
    restriction: CodRestrictionDto | null;
}

/**
 * Named fields, not a pass-through — the rule `toBotMemoryReset` follows in the user
 * gateway. Both gateways answer through this, so the two mounts cannot drift apart and a
 * field jovi-mall adds to its report later does not reach the dashboard until it is named.
 */
export function toCodRestrictionReport(result: CodRestrictionReport): CodRestrictionReport {
    const restriction = result.restriction;
    return {
        subject: result.subject,
        subjectId: result.subjectId,
        userId: result.userId ?? null,
        restricted: result.restricted === true,
        restriction: restriction
            ? {
                  reason: restriction.reason,
                  restrictedAt: restriction.restrictedAt,
                  restrictedByUserId: restriction.restrictedByUserId ?? null,
                  restrictedBySource: restriction.restrictedBySource,
                  restrictedByName: restriction.restrictedByName ?? null,
              }
            : null,
    };
}

/**
 * The audit row's view of a restriction report: the one thing the write can change.
 *
 * Used for BOTH halves of the diff — the `before` is the report as read just ahead of the
 * write, the `after` is jovi-mall's answer to it — so a row reads `false → true` for a
 * restriction and `true → false` for a lift. The reason is the row's `payload`, not state:
 * on a lift jovi-mall clears the field, and the payload is then the only place the reason
 * given for lifting survives.
 */
export function codRestrictionAuditState(result: unknown): Record<string, unknown> | null {
    const report = result as CodRestrictionReport | null;
    if (!report || typeof report !== 'object') return null;
    return { codRestricted: report.restricted === true };
}

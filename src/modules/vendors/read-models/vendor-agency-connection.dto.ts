import { AgencyReadModel } from '../../agencies/repositories/agency.read.repository';
import { ConnectionReadModel } from '../repositories/vendor-context.read.repository';

/**
 * A vendor's delivery-agency connection, as one row (BR-018).
 *
 * ── What this is the mirror of ────────────────────────────────────────────────
 * `GET /agencies/:agencyId/agents` answers *"who works for this agency, and on what
 * terms"*. This is the same question from the other side of the platform: *"which agencies
 * does this vendor ship through, and on what terms"*. The shape follows that precedent
 * deliberately — a relationship row decorated with the party the reader does not already
 * know, never a second agency directory.
 *
 * ── What it replaces ──────────────────────────────────────────────────────────
 * Seven integers. `GET /vendors/:vendorId` reports `counts.agencyConnections` grouped by
 * status, so an operator could see that six connections were active and not which six.
 * These rows are the same population, one document each.
 *
 * ── The two rules this file exists to hold ────────────────────────────────────
 *  1. **Named-field mapping, never a spread.** The projection is the first lock and this
 *     is the second: a field added to `vendor_agency_connections` upstream lands in the
 *     read model and stops here, rather than reaching the wire in `snake_case`.
 *  2. **An event that did not happen is `null`, not a block of nulls.** `rejection`,
 *     `withdrawal` and `termination` are whole objects when they occurred and `null` when
 *     they did not — the `dispute` pattern from `GET /orders/:orderId`. A block of null
 *     fields reads as "we do not know", which is a different and wrong claim.
 *
 * `reapproval` is deliberately NOT on that list, and the difference is worth stating: it
 * is a STATE, not an event. `requiredFrom` and `pausedReason` say which side has to move
 * and why, and a client rendering a `paused_reapproval` row reads them every time; a
 * client rendering any other row reads nulls that truthfully mean "not paused".
 */

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Enough of the agency to recognise it, and no more.
 *
 * The same four fields `toAgentContractDto` returns, for the same reason it returns them:
 * this is a *relationship row*, not an agency record. The full agency lives one click away
 * behind `agencies.read` and its own projection, which is where the sensitive-field
 * argument is made properly.
 */
export interface ConnectionAgencyDto {
    id: string;
    /**
     * ⚠ **The Magazin's business name, and `null` when it has none** — never `""`, and
     * never `contactName` substituted. `display_name` on a `delivery_agencies` row is the
     * agency's contact *individual*; the distinction BR-006 established holds here
     * unchanged. An agency mid-onboarding legitimately has no business name yet and must
     * still be identifiable by its id.
     */
    businessName: string | null;
    status: string | null;
    /** The contact **person**. See the warning on `businessName`. */
    contactName: string | null;
    country: string | null;
}

/** Who refused the request, when, and why. `null` on a connection never rejected. */
export interface ConnectionRejectionDto {
    reason: string | null;
    byRole: string | null;
    byUserId: string | null;
    at: string | null;
}

/** Who took the request back, and when. `null` on a connection never withdrawn. */
export interface ConnectionWithdrawalDto {
    byRole: string | null;
    byUserId: string | null;
    at: string | null;
}

/** Who ended the relationship, when, and on what grounds. `null` if it still stands. */
export interface ConnectionTerminationDto {
    byRole: string | null;
    byUserId: string | null;
    at: string | null;
    /** `unilateral` or `reapproval_declined`. jovi-mall's vocabulary, rendered raw. */
    reason: string | null;
    note: string | null;
}

export interface VendorAgencyConnectionDto {
    id: string;
    /**
     * `null` when the joined agency row is missing — a connection pointing at an agency
     * that no longer exists. That is a broken state and precisely the one an administrator
     * opens this panel to find, which is why the row survives rather than being dropped.
     */
    agency: ConnectionAgencyDto | null;
    /**
     * `pending` · `active` · `rejected` · `withdrawn` · `paused_reapproval` · `terminated`.
     * Rendered raw: the vocabulary is jovi-mall's and a client treats an unknown value as
     * unknown rather than as an error (ADR-005 D-17).
     */
    status: string;
    /** Whether this agency is the vendor's `defaultDeliveryAgencyId`. */
    isDefault: boolean;
    /**
     * How many of the vendor's products this agency answers for — the product's own
     * override, else the vendor's default. Counted across every non-deleted listing in
     * every status, so it agrees with `counts.products.total` on the vendor detail rather
     * than with the active subset.
     */
    productCount: number;
    /**
     * `vendor` or `agency`. **On a `pending` row this is the entire question** — it says
     * whose turn it is to answer, exactly as `terms.proposedBy` does on a pending contract.
     */
    requestedBy: string | null;
    requestedAt: string | null;
    respondedAt: string | null;
    /** Each side's `policy_version` as it stood at the moment of (re)approval. */
    policyVersions: {
        vendorAtApproval: number | null;
        agencyAtApproval: number | null;
    };
    /**
     * Set only while `status === 'paused_reapproval'`. **This is what makes a paused row
     * actionable**: `requiredFrom` names the side that has to move, and `pausedReason`
     * (`vendor_policy_changed` / `agency_policy_changed`) says whose edit caused it.
     */
    reapproval: {
        requiredFrom: string | null;
        pausedAt: string | null;
        pausedReason: string | null;
    };
    rejection: ConnectionRejectionDto | null;
    withdrawal: ConnectionWithdrawalDto | null;
    termination: ConnectionTerminationDto | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * The agency decoration.
 *
 * `magazin.name` for the business, `display_name` for the person — never the other way
 * round, and never one standing in for the other.
 */
function toConnectionAgencyDto(agency: AgencyReadModel): ConnectionAgencyDto {
    return {
        id: agency._id.toString(),
        businessName: agency.magazin?.name ?? null,
        status: agency.status ?? null,
        contactName: agency.display_name ?? null,
        country: agency.country ?? null,
    };
}

export function toVendorAgencyConnectionDto(
    connection: ConnectionReadModel,
    agency: AgencyReadModel | undefined,
    vendorDefaultAgencyId: string | null,
    productCounts: Map<string, number>,
): VendorAgencyConnectionDto {
    const agencyId = connection.agency_id?.toString() ?? '';
    const rejection = connection.rejection;
    const withdrawal = connection.withdrawal;
    const termination = connection.termination;

    return {
        id: connection._id.toString(),
        agency: agency ? toConnectionAgencyDto(agency) : null,
        status: connection.status,
        isDefault: agencyId !== '' && agencyId === vendorDefaultAgencyId,
        // Absent from the map means the vendor has no product resolving here — which is
        // `0`, not "unknown". A pending connection carries no products by definition, and
        // that is the honest number rather than a missing field.
        productCount: productCounts.get(agencyId) ?? 0,

        requestedBy: str(connection.requester_role),
        requestedAt: toIso(connection.requested_at),
        respondedAt: toIso(connection.responded_at),

        policyVersions: {
            vendorAtApproval: num(connection.vendor_policy_version_at_approval),
            agencyAtApproval: num(connection.agency_policy_version_at_approval),
        },

        reapproval: {
            requiredFrom: str(connection.reapproval_required_from),
            pausedAt: toIso(connection.paused_at),
            pausedReason: str(connection.paused_reason),
        },

        rejection: rejection
            ? {
                  reason: str(rejection.reason),
                  byRole: str(rejection.rejected_by_role),
                  byUserId: rejection.rejected_by_user_id?.toString() ?? null,
                  at: toIso(rejection.rejected_at),
              }
            : null,
        withdrawal: withdrawal
            ? {
                  byRole: str(withdrawal.withdrawn_by_role),
                  byUserId: withdrawal.withdrawn_by_user_id?.toString() ?? null,
                  at: toIso(withdrawal.withdrawn_at),
              }
            : null,
        termination: termination
            ? {
                  byRole: str(termination.terminated_by_role),
                  byUserId: termination.terminated_by_user_id?.toString() ?? null,
                  at: toIso(termination.terminated_at),
                  reason: str(termination.reason),
                  note: str(termination.note),
              }
            : null,

        createdAt: toIso(connection.created_at) ?? String(connection.created_at),
        updatedAt: toIso(connection.updated_at) ?? String(connection.updated_at),
    };
}

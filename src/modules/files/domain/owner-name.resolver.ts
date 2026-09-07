import { ObjectId } from 'mongodb';
import { AdminAccountRepository } from '../../admin-identity/repositories/admin-account.repository';
import { AgencyReadRepository } from '../../agencies/repositories/agency.read.repository';
import { AgentReadRepository } from '../../agents/repositories/agent.read.repository';
import { findCustomerNamesByIds } from '../../users/repositories/role-profile.read.repository';
import { StoreReadRepository } from '../../vendors/repositories/store.read.repository';
import { StoredFileReadModel } from '../repositories/file-library.read.repository';

/**
 * Turning `(ownerType, ownerId)` into a NAME — the ask's own words: *"the owner (name and
 * role)"* (BR-015).
 *
 * ── ⚠ `ownerId` is an id in a DIFFERENT id space per owner type ─────────────────────────
 * This is the whole difficulty, and it is why the file row alone cannot answer the
 * question. `ownerId` is stamped from `req.auth.role_entity._id` at upload, so it is:
 *
 * | `ownerType` | `ownerId` is | The NAME lives on |
 * |---|---|---|
 * | `vendor`   | `vendors._id`          | `stores.name` — the shop's business name, joined on `vendor_id` |
 * | `agency`   | `delivery_agencies._id`| `agency_magazins.name` — the Magazin's business name |
 * | `agent`    | `delivery_agents._id`  | `delivery_agents.name` — a person; agents have no business identity |
 * | `customer` | `customers._id`        | `customers.name` |
 * | `admin`    | **`wi_admin.admin_accounts._id`** | this service's OWN database |
 * | `system`   | absent                 | nowhere — `null` by construction |
 *
 * Two of those are the platform's business-identity split (ADR-008 / ADR-009): `vendors`
 * and `delivery_agencies` both carry a `display_name`, and it is the CONTACT PERSON, not
 * the business. Reading it would print a human's name in a column headed "Vendor" — the
 * exact mislabelling `AgencyReadRepository.findBusinessNamesByIds` was split out to fix. So
 * both resolve through the business-name resolver their own module already owns, and
 * neither falls back to the contact.
 *
 * The `admin` row is the interesting one: it resolves in a database jovi-mall cannot read,
 * against a collection jovi-mall's own column declares a `ref` to and can never dereference
 * (ADR-004 D-1). It is the single strongest reason this listing could not have been
 * delegated.
 *
 * ── One query per owner type PRESENT, never one per row ─────────────────────────────────
 * Resolution runs on the page AFTER skip/limit, so it sees at most `limit` rows. A page of
 * one owner type costs one query; a page mixing all five costs five. The
 * `hydrateOwnerNames` shape in `billing.controller.ts` is the precedent and this follows it
 * exactly, including keying the result on `type:id` so two owner types cannot collide on a
 * shared id value.
 *
 * ── `null` is a real answer, and there are four ways to get it ──────────────────────────
 * `system` (no name exists), a deleted role record, an owner mid-onboarding with no
 * business name yet, and an administrator removed from this service. **`null`, never `''`,
 * and never the id substituted silently** (ADR-005). A client renders all four the same way,
 * which is why they are not distinguished.
 */

const stores = new StoreReadRepository();
const agencies = new AgencyReadRepository();
const agents = new AgentReadRepository();
const administrators = new AdminAccountRepository();

/** Keyed `type:id`, because an id is only unique within its own owner type. */
export type OwnerNames = Map<string, string | null>;

export function ownerKey(type: string, id: string): string {
    return `${type}:${id}`;
}

/**
 * Resolve every owner named on a page of file rows.
 *
 * A row with no `ownerType`, no `ownerId`, or `ownerType: 'system'` contributes no query
 * and resolves to `null` at the call site — `system` has no record anywhere to look up, and
 * the model's own comment says so (*"null for 'system' owner type"*).
 */
export async function resolveOwnerNames(rows: StoredFileReadModel[]): Promise<OwnerNames> {
    const idsFor = (type: string): string[] => [
        ...new Set(
            rows
                .filter((row) => row.ownerType === type && row.ownerId)
                .map((row) => row.ownerId!.toString()),
        ),
    ];

    const vendorIds = idsFor('vendor');
    const agencyIds = idsFor('agency');
    const agentIds = idsFor('agent');
    const customerIds = idsFor('customer');
    const adminIds = idsFor('admin');

    const toObjectIds = (ids: string[]): ObjectId[] => ids.map((id) => new ObjectId(id));

    const [vendorStores, agencyNames, agentNames, customerNames, adminNames] = await Promise.all([
        stores.findForVendors(toObjectIds(vendorIds)),
        agencies.findBusinessNamesByIds(toObjectIds(agencyIds)),
        agents.findNamesByIds(toObjectIds(agentIds)),
        findCustomerNamesByIds(toObjectIds(customerIds)),
        administrators.findDisplayNamesByIds(adminIds),
    ]);

    const names: OwnerNames = new Map();

    // `stores.findForVendors` is keyed on `vendor_id`, which IS the file's `ownerId`.
    vendorStores.forEach((store, vendorId) => {
        names.set(ownerKey('vendor', vendorId), store.name ?? null);
    });
    agencyNames.forEach((name, id) => names.set(ownerKey('agency', id), name));
    agentNames.forEach((name, id) => names.set(ownerKey('agent', id), name));
    customerNames.forEach((name, id) => names.set(ownerKey('customer', id), name));
    adminNames.forEach((name, id) => names.set(ownerKey('admin', id), name));

    return names;
}

/** The name for one row, or `null`. Never `''`, and never the id. */
export function ownerNameOf(row: StoredFileReadModel, names: OwnerNames): string | null {
    if (!row.ownerType || !row.ownerId) return null;
    return names.get(ownerKey(row.ownerType, row.ownerId.toString())) ?? null;
}

import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors/app-error';
import { ERROR_CODES } from '../../../core/errors/error-codes';
import { AdminIdentity } from '../../admin-identity/domain/admin-identity.types';
import { IAdminAccount } from '../../admin-identity/models/admin-account.model';
import { AdminAccountRepository } from '../../admin-identity/repositories/admin-account.repository';
import { auditedTransaction } from '../../audit/domain/audit.writer';
import { ActorContext, auditActorOf } from '../../audit/domain/audit-context';
import { AuditAction } from '../../audit/domain/audit.catalog';
import { AuditContext } from '../../audit/domain/audit.types';
import { EmployeeRecordRepository } from '../repositories/employee-record.repository';
import { IEmployeeRecord } from '../models/employee-record.model';
import { EmployeeRecordDto, toEmployeeRecordDto } from '../read-models/employee-record.dto';
import {
    EMPLOYEE_DOCUMENT_SLOTS,
    EMPLOYEE_MULTI_SLOT_MAX_FILES,
    EmployeeDocumentSlot,
    employeeSlotField,
} from './employee-document.types';
import { UpdateEmployeeRecordInput, UpdateEmploymentInput } from '../validators/employee.validator';
import { detachStaffDocument } from '../gateways/employee-document.gateway';

/**
 * ─── The employee record ─────────────────────────────────────────────────────
 *
 * Everything the company holds about a member of its own staff. Written almost entirely by
 * the subject about themselves; read by the subject and by a tier-1 Developer, and by nobody
 * else at all.
 *
 * ── ⚠ THE ONE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────
 * **Self-service writes never carry an id.** Every function below that writes the personal,
 * identity, address, contact or payout half takes the actor and derives the subject FROM the
 * actor. There is no `adminId` parameter on any of them, and adding one would be the single
 * most consequential change anybody could make to this module: it would turn a surface with
 * no authorization decision into one with a decision that has to be got right, on a payload
 * that is a photograph of somebody holding their identity card.
 *
 * The reviewer's side is the mirror image: `getForReview` takes an id and no write does. A
 * tier-1 Developer reads this evidence; they do not supply it. If somebody ever needs to
 * correct an employee's record on their behalf, that is a NEW named route with its own
 * permission and its own audit action — not a parameter added here.
 *
 * ── The employment block is the exception, and it is the other way round ────
 * `updateEmployment` takes an id and is called only by the tier-1 route. It is what the
 * company says about the employee — salary, contract, start date — and an employee able to
 * write it would make the collection worthless as a record of anything.
 */

const accounts = new AdminAccountRepository();
const records = new EmployeeRecordRepository();

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadAccount(adminId: string): Promise<IAdminAccount> {
    const account = await accounts.findById(adminId);
    if (!account) throw createAppError(ERROR_CODES.ADMIN_ACCOUNT_NOT_FOUND, 404);
    return account;
}

function intentFor(
    action: AuditAction,
    actor: AdminIdentity,
    context: AuditContext,
    target: { id: string; label?: string | null },
) {
    return {
        action,
        actor: auditActorOf(actor),
        target: { type: 'administrator' as const, id: target.id, label: target.label ?? null },
        context,
    };
}

/**
 * The fields an audit row may carry from this record — and, more importantly, the ones it
 * may NOT.
 *
 * ── ⚠ THE AUDIT ROW RECORDS THAT A FIELD CHANGED, NOT WHAT IT CHANGED TO ────
 * Every other audited write on this service puts a `before`/`after` diff in the row, and that
 * is right for a plan change or a tier change. It is wrong here, and the reason is that the
 * audit log has a WIDER audience than this record does: `audit.read` is granted to every tier
 * including Support, narrowed per row by `auditScopeFilter`. A `before`/`after` carrying a
 * date of birth, a mother's maiden name and a home address would route this record's contents
 * through a feed it is specifically withheld from.
 *
 * So the row names the KEYS that changed and never their values. That answers the question an
 * audit trail is opened for — *who changed what, when* — without turning the trail into the
 * leak, which is the rule the payout and tracking disclosures already follow.
 *
 * ⚠ Do not "improve" this by adding values. `test:employees` § 4 asserts their absence.
 */
function changedKeys(input: Record<string, unknown>): string[] {
    return Object.keys(input).sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** The caller's own record. Never 404s — an untouched record is an empty one, not a missing one. */
export async function getOwnRecord(actor: AdminIdentity): Promise<EmployeeRecordDto> {
    const account = await loadAccount(actor.adminId);
    return toEmployeeRecordDto(account, await records.findByAdminId(actor.adminId));
}

/**
 * Somebody else's record, for a tier-1 Developer.
 *
 * ⚠ **Not audited, and that is a decision worth defending** (ADR-023 D-7). The service's own
 * rule is that a read is audited when the disclosure IS the action — a payout destination, a
 * live position, a delivery-proof photograph. This read is squarely in that class and is
 * still not audited, because it returns **no bytes and no coordinates a client can act on**:
 * it returns ids, and every id whose content is sensitive requires a second call to
 * `GET /api/v1/files/:fileId/content`, which IS audited, per file, fail-closed.
 *
 * So the disclosure of the pictures is recorded where it happens, one row per document, which
 * is a strictly better trail than one row saying "opened the file". What this read adds on top
 * is the typed half — a salary and a date of birth — and auditing THAT would put a row in a
 * feed Support can read every time a Developer opens the screen, for a disclosure to the one
 * tier that is allowed it.
 *
 * ⚠ If a future version returns anything the caller can act on without a second call — a
 * decrypted account number, an inline image — this decision has to be revisited in the same
 * change.
 */
export async function getRecordForReview(adminId: string): Promise<EmployeeRecordDto> {
    const account = await loadAccount(adminId);
    return toEmployeeRecordDto(account, await records.findByAdminId(adminId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-service writes
// ─────────────────────────────────────────────────────────────────────────────

/** Map the wire's camelCase patch onto the document's snake_case columns. */
function toRecordUpdate(input: UpdateEmployeeRecordInput): Record<string, unknown> {
    const update: Record<string, unknown> = {};
    const set = (column: string, value: unknown) => {
        if (value !== undefined) update[column] = value;
    };

    set('full_name', input.fullName);
    set('date_of_birth', input.dateOfBirth);
    set('place_of_birth', input.placeOfBirth);
    set('gender', input.gender);
    set('nationality', input.nationality);
    set('mother_full_name', input.motherFullName);
    set('father_full_name', input.fatherFullName);
    set('id_number', input.idNumber);
    set('id_type', input.idType);
    set('id_expires_on', input.idExpiresOn);
    set('home_address', input.homeAddress);

    // Arrays are a FULL REPLACE, and `null` means "empty it". Both normalise to `[]` here so
    // the document never holds `null` where a reader expects an array — which is the shape
    // that makes `record.phones.length` throw two years later.
    if (input.phones !== undefined) {
        update.phones = (input.phones ?? []).map((p) => ({ label: p.label ?? null, number: p.number }));
    }
    if (input.relatives !== undefined) {
        update.relatives = (input.relatives ?? []).map((r) => ({
            full_name: r.fullName,
            relationship: r.relationship,
            phones: r.phones.map((p) => ({ label: p.label ?? null, number: p.number })),
        }));
    }
    if (input.payoutMethods !== undefined) {
        update.payout_methods = input.payoutMethods ?? [];
    }

    return update;
}

/**
 * The employee updating their own record.
 *
 * ── ⚠ There is NO LOCK, unlike the applicant KYC record ─────────────────────
 * jovi-mall's KYC module freezes a record once it is submitted or verified, and the second
 * half is load-bearing there: without it an approved applicant swaps the identity card an
 * administrator already looked at.
 *
 * That reasoning does not carry here, and copying the lock would be actively wrong. An
 * employee moves house, changes their phone and switches bank. A record they cannot correct
 * after activation is stale within a year, and a company whose staff addresses are a year out
 * of date has collected them for nothing. The activation decision is about the PERSON, not
 * about a snapshot of their paperwork — and every subsequent change is audited, which is the
 * control that replaces the freeze.
 */
export async function updateOwnRecord(
    actor: AdminIdentity,
    input: UpdateEmployeeRecordInput,
    context: AuditContext,
): Promise<EmployeeRecordDto> {
    const account = await loadAccount(actor.adminId);
    const update = toRecordUpdate(input);
    update.last_self_update_at = new Date();

    const record = await auditedTransaction(
        {
            ...intentFor('employees.record.update_self', actor, context, {
                id: actor.adminId,
                label: actor.email,
            }),
            // Keys only, never values — see `changedKeys`.
            payload: { fields: changedKeys(input) },
        },
        async (session) => {
            const updated = await records.applyUpdate(actor.adminId, update, session);
            return {
                result: updated,
                before: null,
                after: { fields: changedKeys(input) },
            };
        },
    );

    return toEmployeeRecordDto(account, record);
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────────

/** A slot's current ids, as strings, whatever its cardinality. */
function readSlot(record: IEmployeeRecord | null, slot: EmployeeDocumentSlot): string[] {
    if (!record) return [];
    const raw = (record as unknown as Record<string, unknown>)[employeeSlotField(slot)];
    if (Array.isArray(raw)) return raw.filter(Boolean).map((id) => String(id));
    return raw ? [String(raw)] : [];
}

/**
 * Refuse an upload that would overflow a slot, BEFORE the bytes cross the hop.
 *
 * Checked first, deliberately: the alternative is uploading ten files and then telling the
 * caller the slot holds one, which has already spent the bandwidth, run the virus scan and
 * written rows jovi-mall must now sweep.
 */
export async function assertSlotHasRoom(
    actor: AdminIdentity,
    slot: EmployeeDocumentSlot,
    offered: number,
): Promise<void> {
    const record = await records.findByAdminId(actor.adminId);
    const current = readSlot(record, slot);
    const multi = EMPLOYEE_DOCUMENT_SLOTS[slot] === 'multi';

    if (!multi) {
        if (offered > 1) {
            throw createAppError(
                ERROR_CODES.EMPLOYEE_SLOT_FULL,
                422,
                'This slot holds exactly one file',
                { slot, max: 1, current: current.length, offered },
            );
        }
        return;
    }

    if (current.length + offered > EMPLOYEE_MULTI_SLOT_MAX_FILES) {
        throw createAppError(
            ERROR_CODES.EMPLOYEE_SLOT_FULL,
            422,
            `This slot holds at most ${EMPLOYEE_MULTI_SLOT_MAX_FILES} files`,
            { slot, max: EMPLOYEE_MULTI_SLOT_MAX_FILES, current: current.length, offered },
        );
    }
}

/**
 * File uploaded ids into a slot, and clean up whatever a single-value slot displaced.
 *
 * ── The ordering, and why it is this way round ──────────────────────────────
 * The slot write commits FIRST, and the displaced file is detached at jovi-mall AFTER. That
 * ordering is deliberate and the failure modes are not symmetric:
 *
 *   commit-then-detach: if the detach fails, the record is correct and jovi-mall holds a file
 *   nothing points at. The orphan sweep finds it; nobody is harmed.
 *
 *   detach-then-commit: if the commit fails, the record still points at a file that has been
 *   soft-deleted. The document renders as broken, forever, and nothing anywhere says why.
 *
 * The second is worse, so the first is what happens. It is also forced: `auditedTransaction`
 * may re-run its callback on a write conflict, so an HTTP call inside one fires twice.
 */
export async function attachDocuments(
    actor: AdminIdentity,
    slot: EmployeeDocumentSlot,
    uploadedFileIds: string[],
    context: ActorContext,
): Promise<EmployeeRecordDto> {
    const account = await loadAccount(actor.adminId);
    const existing = await records.findByAdminId(actor.adminId);
    const previous = readSlot(existing, slot);
    const multi = EMPLOYEE_DOCUMENT_SLOTS[slot] === 'multi';

    const next = multi ? [...previous, ...uploadedFileIds] : uploadedFileIds;
    const column = employeeSlotField(slot);

    const record = await auditedTransaction(
        {
            ...intentFor('employees.documents.attach', actor, context, {
                id: actor.adminId,
                label: actor.email,
            }),
            payload: { slot, added: uploadedFileIds.length },
        },
        async (session) => {
            const updated = await records.applyUpdate(
                actor.adminId,
                {
                    [column]: multi
                        ? next.map((id) => new Types.ObjectId(id))
                        : next[0]
                            ? new Types.ObjectId(next[0])
                            : null,
                    last_self_update_at: new Date(),
                },
                session,
            );
            return {
                result: updated,
                before: { slot, fileIds: previous },
                after: { slot, fileIds: next },
            };
        },
    );

    /**
     * A single-value slot REPLACES, so whatever it held is nobody's now.
     *
     * Removed rather than left to the sweep: this is a photograph of a national identity card,
     * and an unreferenced-file grace period is not the right place for one. Best-effort and
     * post-commit — see the ordering note above.
     */
    if (!multi) {
        for (const stale of previous.filter((id) => !next.includes(id))) {
            await detachStaffDocument(stale, context);
        }
    }

    return toEmployeeRecordDto(account, record);
}

/** Remove one document from a slot: the id comes out of the record, then the file goes. */
export async function detachDocument(
    actor: AdminIdentity,
    slot: EmployeeDocumentSlot,
    fileId: string,
    context: ActorContext,
): Promise<EmployeeRecordDto> {
    const account = await loadAccount(actor.adminId);
    const existing = await records.findByAdminId(actor.adminId);
    const previous = readSlot(existing, slot);

    /**
     * 404 when the slot does not hold this id — and note this is also the ownership check.
     *
     * The record was loaded by `actor.adminId`, so a file id belonging to another
     * administrator simply is not in `previous`. jovi-mall re-checks ownership on its side
     * too; neither check is redundant, because this one scopes to a SLOT and that one scopes
     * to an OWNER, and a caller naming their own file under the wrong slot should not silently
     * delete it.
     */
    if (!previous.includes(fileId)) {
        throw createAppError(ERROR_CODES.EMPLOYEE_DOCUMENT_NOT_FOUND, 404, 'Document not found in this slot');
    }

    const next = previous.filter((id) => id !== fileId);
    const multi = EMPLOYEE_DOCUMENT_SLOTS[slot] === 'multi';
    const column = employeeSlotField(slot);

    const record = await auditedTransaction(
        {
            ...intentFor('employees.documents.detach', actor, context, {
                id: actor.adminId,
                label: actor.email,
            }),
            payload: { slot, fileId },
        },
        async (session) => {
            const updated = await records.applyUpdate(
                actor.adminId,
                {
                    [column]: multi
                        ? next.map((id) => new Types.ObjectId(id))
                        : next[0]
                            ? new Types.ObjectId(next[0])
                            : null,
                    last_self_update_at: new Date(),
                },
                session,
            );
            return {
                result: updated,
                before: { slot, fileIds: previous },
                after: { slot, fileIds: next },
            };
        },
    );

    // Post-commit, best-effort, for the reason `attachDocuments` explains.
    await detachStaffDocument(fileId, context);

    return toEmployeeRecordDto(account, record);
}

// ─────────────────────────────────────────────────────────────────────────────
// The employment block — tier 1 writes it, the employee reads it
// ─────────────────────────────────────────────────────────────────────────────

export async function updateEmployment(
    actor: AdminIdentity,
    adminId: string,
    input: UpdateEmploymentInput,
    context: AuditContext,
): Promise<EmployeeRecordDto> {
    const account = await loadAccount(adminId);

    const update: Record<string, unknown> = {
        employment_updated_at: new Date(),
        employment_updated_by: new Types.ObjectId(actor.adminId),
    };
    const set = (column: string, value: unknown) => {
        if (value !== undefined) update[`employment.${column}`] = value;
    };

    set('position', input.position);
    set('department', input.department);
    set('employment_type', input.employmentType);
    set('staff_number', input.staffNumber);
    set('started_on', input.startedOn);
    set('ended_on', input.endedOn);
    set('monthly_salary_minor', input.monthlySalaryMinor);
    set('currency', input.currency);
    set('notes', input.notes);

    const record = await auditedTransaction(
        {
            ...intentFor('employees.employment.update', actor, context, {
                id: adminId,
                label: account.email,
            }),
            /**
             * ⚠ Keys only — and here the omission matters more than anywhere else on this
             * service. `audit.read` reaches tier 3, narrowed per row; a `before`/`after`
             * carrying `monthlySalaryMinor` would publish a colleague's salary to the feed.
             * That the actor is tier 1 does not help: the ROW's audience is not the actor's.
             */
            payload: { fields: changedKeys(input) },
        },
        async (session) => {
            const updated = await records.applyUpdate(adminId, update, session);
            return {
                result: updated,
                before: null,
                after: { fields: changedKeys(input) },
            };
        },
    );

    return toEmployeeRecordDto(account, record);
}

// ─────────────────────────────────────────────────────────────────────────────
// The avatar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Point the account at a picture, or clear it.
 *
 * ⚠ **The file is NOT verified to exist here, and that is the same call the rest of this
 * service makes.** Every file reference on this surface is an id into `jovi_mall.files`, and
 * an id that resolves to nothing is a state clients already handle — `GET /files?ids=` answers
 * a shorter list than it was asked for, on purpose, because files are soft-deleted and swept.
 * Verifying would mean an HTTP round trip on every avatar change to turn a rendering
 * difference into a 422.
 *
 * What it means practically: a client that sets an avatar to an id it did not just receive
 * from `POST /files/upload` may set a broken one. That is the client's mistake to avoid and it
 * is visible immediately.
 */
export async function setAvatar(
    actor: AdminIdentity,
    fileId: string | null,
    context: AuditContext,
): Promise<{ avatarFileId: string | null }> {
    const account = await loadAccount(actor.adminId);
    const previous = account.avatar_file_id ? account.avatar_file_id.toString() : null;

    return auditedTransaction(
        {
            ...intentFor('employees.avatar.set', actor, context, {
                id: actor.adminId,
                label: actor.email,
            }),
            payload: { fileId },
        },
        async (session) => {
            await accounts.setAvatar(actor.adminId, fileId, session);
            return {
                result: { avatarFileId: fileId },
                /**
                 * The one place on this module where a value IS recorded, and it is safe:
                 * an avatar id names a file in a PUBLIC tree that every administrator may
                 * already resolve. Nothing is disclosed by the row that the directory does
                 * not disclose anyway.
                 */
                before: { avatarFileId: previous },
                after: { avatarFileId: fileId },
            };
        },
    );
}

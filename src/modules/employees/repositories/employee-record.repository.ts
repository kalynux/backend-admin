import { ClientSession, Types } from 'mongoose';
import { EmployeeRecordModel, IEmployeeRecord } from '../models/employee-record.model';

/**
 * The only code that touches `admin_employee_records`.
 *
 * ── ⚠ There is deliberately no `list()`, and no query by anything but `admin_id` ──
 * Every other directory-shaped collection on this service has a paged, filtered list. This
 * one must not, and the absence is the control (ADR-023 D-6).
 *
 * A listing route would be the one way to ask *"show me every salary"* or *"show me
 * everybody's home address"* — a question this record exists to answer one person at a time,
 * for a named reason, with an audit row naming who asked. The permission alone would not stop
 * it: `employees.read` is tier 1, and a Developer legitimately holds it. What stops it is that
 * the query does not exist.
 *
 * This mirrors geo-tracker's trail, which is reachable **only** by naming a shipment and has
 * no listing route of any kind, for the same reason its own module states: a configuration
 * mistake cannot widen a bound that is structural. If a payroll export is ever wanted, it is
 * its own permission, its own audited route and its own decision — not a `limit` parameter
 * somebody adds here on a Tuesday.
 */
export class EmployeeRecordRepository {
    /** The record, or null when this administrator has never opened the form. */
    async findByAdminId(adminId: string, session?: ClientSession): Promise<IEmployeeRecord | null> {
        if (!Types.ObjectId.isValid(adminId)) return null;
        return EmployeeRecordModel()
            .findOne({ admin_id: new Types.ObjectId(adminId) })
            .session(session ?? null)
            .exec();
    }

    /**
     * The record, created empty if it does not exist yet.
     *
     * ── Why upsert rather than create-on-account-creation ────────────────────
     * An administrator created before this feature shipped has no row, and neither does one
     * created by the bootstrap CLI. Creating the shell lazily means `null` never has to be a
     * state the write paths reason about, and no backfill is needed — which matters, because
     * this platform's standing rule is that pre-production data is disposable and migrations
     * are for indexes only (D-5, 2026-08-21).
     *
     * `upsert` with `$setOnInsert` rather than find-then-create: two concurrent first writes
     * from the same administrator (a dashboard saving two sections at once) would otherwise
     * race, and the unique index on `admin_id` would turn the loser into an 11000 the user
     * sees as a failed save of a form they filled in correctly.
     */
    async ensureForAdmin(adminId: string, session?: ClientSession): Promise<IEmployeeRecord> {
        const _id = new Types.ObjectId(adminId);
        const record = await EmployeeRecordModel()
            .findOneAndUpdate(
                { admin_id: _id },
                { $setOnInsert: { admin_id: _id } },
                { upsert: true, new: true, setDefaultsOnInsert: true, session: session ?? null },
            )
            .exec();
        return record as IEmployeeRecord;
    }

    /**
     * Apply a `$set` to the record, creating it if absent.
     *
     * Takes an already-built update object rather than a typed patch: the service owns which
     * fields a given route may touch, and duplicating that list here as a second allowlist
     * would be a second place for it to be wrong. What this guarantees instead is narrower
     * and checkable — the update is always scoped to ONE `admin_id`.
     */
    async applyUpdate(
        adminId: string,
        update: Record<string, unknown>,
        session?: ClientSession,
    ): Promise<IEmployeeRecord> {
        const _id = new Types.ObjectId(adminId);
        const record = await EmployeeRecordModel()
            .findOneAndUpdate(
                { admin_id: _id },
                { $set: update, $setOnInsert: { admin_id: _id } },
                { upsert: true, new: true, setDefaultsOnInsert: true, session: session ?? null },
            )
            .exec();
        return record as IEmployeeRecord;
    }
}

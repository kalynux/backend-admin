import { Router } from 'express';
import { defineRoute, permission, records, selfService } from '../../../api/route-manifest';
import { EmployeeController } from '../controllers/employee.controller';
import {
    EmployeeDocumentParamSchema,
    EmployeeSlotParamSchema,
} from '../domain/employee-document.types';
import {
    EmployeeAdminIdParamSchema,
    SetAvatarSchema,
    UpdateEmployeeRecordSchema,
    UpdateEmploymentSchema,
} from '../validators/employee.validator';

/**
 * `/api/v1/employees` — what the company holds about its own staff (ADR-023).
 *
 * ── ⚠ ROUTE ORDER MATTERS ───────────────────────────────────────────────────
 * Every `/me` route is declared before `/:adminId`. Express matches in registration order, so
 * the reverse would read "me" as an id and fail the ObjectId check — and this service has been
 * bitten by route order before.
 *
 * ── The two halves, and why they are not one ─────────────────────────────────
 * `/me/*` takes no id and needs no permission: it acts on the caller, so there is no
 * authorization decision to make. `/:adminId` takes one and is tier 1 through
 * `employees.read` / `employees.employment.write`.
 *
 * The result is that the SETS ARE ALMOST DISJOINT — an employee writes their own record and
 * cannot name anybody else's; a Developer reads a colleague's and cannot alter what is in it.
 * The one crossing is `PATCH /:adminId/employment`, which is the company stating its terms,
 * and it is the only write on this mount that takes an id.
 *
 * ── There is deliberately no LIST ────────────────────────────────────────────
 * No `GET /employees`, at any tier, and the repository has no query to build one from
 * (ADR-023 D-6). A listing would be the one way to ask "show me every salary" or "show me
 * everybody's home address" — questions this record exists to answer one person at a time.
 * The permission does not stop that: tier 1 legitimately holds `employees.read`. What stops it
 * is that the query does not exist, which is the same structural bound geo-tracker puts on a
 * tracking trail. If a payroll export is ever wanted, it is its own permission, its own
 * audited route and its own decision.
 *
 * ── There is deliberately no DELETE ──────────────────────────────────────────
 * An employment record outlives the employment — that is most of what it is for. Departure is
 * `employment.endedOn`, and access is removed by suspending the account.
 */
const router = Router();
const mountedAt = '/employees';

// ─── The caller's own record — no permission, by definition ──────────────────
//
// All five are on `ONBOARDING_ROUTE_ALLOWLIST`: a pending administrator exists precisely so
// they can fill this in, and an account that could not reach its own record would be stuck
// forever. The boot assertion refuses an allowlist entry that is not `selfService`, so these
// two facts cannot drift apart.

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/me',
    access: selfService('Every administrator may read their own employee record'),
    handler: EmployeeController.me,
});

defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/me',
    access: selfService('Every administrator maintains their own employee record'),
    validate: { body: UpdateEmployeeRecordSchema },
    audit: records('employees.record.update_self'),
    handler: EmployeeController.updateMe,
});

/**
 * The profile picture, set by id after uploading through `POST /api/v1/files/upload`.
 *
 * ⚠ `PUT`, not `PATCH`: it replaces the whole value, and `{ fileId: null }` clears it. A PATCH
 * on a single scalar would leave "absent means unchanged" and "null means clear" to be
 * distinguished by a client, for one field.
 *
 * ⚠ It lives on `/employees` rather than on `/administrators/me` even though the column is on
 * `admin_accounts`. The reason is the audience: an avatar is set by the person, alongside the
 * rest of their own profile work, and `PATCH /administrators/me` is also reachable in a form
 * that edits somebody ELSE (`PATCH /administrators/:adminId`). Keeping the two apart is what
 * stops one administrator setting another's picture through a shared handler.
 */
defineRoute(router, {
    mountedAt,
    method: 'put',
    path: '/me/avatar',
    access: selfService('Every administrator may set their own profile picture'),
    validate: { body: SetAvatarSchema },
    audit: records('employees.avatar.set'),
    handler: EmployeeController.setAvatar,
});

/**
 * Upload an identity document into a slot. Multipart, field name `documents`.
 *
 * ⚠ **No `body:` schema, and there cannot be one.** The body is multipart and is piped at
 * jovi-mall unread — a schema here would be handed `{}`, Express's default for a request no
 * parser matched, and would either pass meaninglessly or reject every upload. The two things
 * checkable without parsing, the content type and the declared length, are checked in the
 * controller. Same shape, same reason, as `POST /files/upload`.
 *
 * ⚠ It declares `employees.documents.attach` rather than `...upload`: the upload is recorded
 * by the gateway as an ATTEMPT before the bytes move, and the attach is what commits on
 * success. The probe checks a `records` declaration against a 2xx, so naming the attempt would
 * make every successful upload look like an unmet declaration.
 */
defineRoute(router, {
    mountedAt,
    method: 'post',
    path: '/me/documents/:slot',
    access: selfService('Every administrator uploads their own identity evidence'),
    validate: { params: EmployeeSlotParamSchema },
    audit: records('employees.documents.attach'),
    handler: EmployeeController.uploadDocument,
});

defineRoute(router, {
    mountedAt,
    method: 'delete',
    path: '/me/documents/:slot/:fileId',
    access: selfService('Every administrator may remove their own identity evidence'),
    validate: { params: EmployeeDocumentParamSchema },
    audit: records('employees.documents.detach'),
    handler: EmployeeController.deleteDocument,
});

// ─── Somebody else's record — tier 1 only ────────────────────────────────────

defineRoute(router, {
    mountedAt,
    method: 'get',
    path: '/:adminId',
    access: permission('employees.read'),
    validate: { params: EmployeeAdminIdParamSchema },
    handler: EmployeeController.get,
});

/**
 * The employment block — position, contract, start date, monthly salary.
 *
 * The ONE write on this mount that takes an id, and its scope is narrower than the mount
 * suggests: it cannot touch the personal, identity, address, contact or payout halves. Those
 * have no administrative write path at all, because an employee states their own facts and a
 * Developer who could rewrite them would make the record evidence of nothing.
 */
defineRoute(router, {
    mountedAt,
    method: 'patch',
    path: '/:adminId/employment',
    access: permission('employees.employment.write'),
    validate: { params: EmployeeAdminIdParamSchema, body: UpdateEmploymentSchema },
    audit: records('employees.employment.update'),
    handler: EmployeeController.updateEmployment,
});

export const employeeRoutes = router;

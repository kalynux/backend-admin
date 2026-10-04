# Frontend changelog: role closure (2026-10-04)

**For:** the admin dashboard. **Contract:** [`api/users.md` § Role closure](./api/users.md#role-closure).
**Background:** jovi-mall `docs/ADR-A10-ROLE-CLOSURE.md`. **Not deployed yet**; it ships with jovi-mall.

## What changed

An administrator can **ask** a user to close ONE of their roles (`customer` · `vendor` ·
`agency` · `agent`). The user confirms or declines it themselves, in their own app, within
7 days. **Nothing in the dashboard closes anything, and there is no confirm button to build.**

⛔ The permission vocabulary goes **128 → 129** with **`users.close`** (destructive). Tiers are
now **129 / 107 / 40**: Developer and Admin hold it, Support does not. Two new audit actions:
`users.close.request` and `users.close.cancel`.

## Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/v1/users/:userId/closure-requests` | `users.read` |
| `POST` | `/api/v1/users/:userId/roles/:role/closure`, body `{ reason }` (3–500 chars, shown to the user) | `users.close` |
| `DELETE` | `/api/v1/users/:userId/roles/:role/closure` | `users.close` |

## Build

1. **User detail page, per role held:** a "Request closure" action, shown only with `users.close`.
   It opens a dialog with a required **reason**, and the copy must make clear the user will be
   asked to confirm. Say **close**, never "delete".
2. **Refusals:** render them from `details.platformCode`. The 422 forwards jovi-mall's itemised list.

   | `details.platformCode` | Show |
   |---|---|
   | `ROLE_CLOSURE_BLOCKED` (422) | `details.blockers[]` as a checklist: `{ code, count, amount?, currency? }`. Codes and meanings are in jovi-mall `api-doc/me/role-closure.md` § Blocker codes |
   | `ROLE_CLOSURE_ALREADY_PENDING` (409) | "A request is already waiting", with a link to it |
   | `ROLE_CLOSURE_ROLE_NOT_HELD` (422) / `ROLE_CLOSED` (409) | The role is not held, or is already closed. Refresh the profiles |
   | `USER_STATUS_CONFLICT` (409) | The account is suspended or closed |
   | `ROLE_CLOSURE_REQUEST_NOT_FOUND` (404, on cancel) | Nothing is pending; the user may have answered first |

3. **Closure requests panel** on the user detail (`GET …/closure-requests`). Show role, `status`
   (`pending` · `confirmed` · `declined` · `cancelled` · `expired`, already effective, so no
   client-side expiry maths), reason, requested by and when, `expiresAt`, `warnings`,
   `declineNote`, and `outcome` (`accountClosed`, `endedRelationships`). Offer **Withdraw** on a
   `pending` row (`users.close`).
4. **Activity feed:** label the two new audit actions. The user's own confirm or decline is
   **not** an audit row; it appears only on the request.
5. **Profiles:** a closed role disappears from `roles`, and its profile reads
   `status: 'inactive'`. If the last role closed, the user is `status: 'closed'`.

## Docs to copy

`admin/api-doc/api/users.md` · this file · jovi-mall `api-doc/me/role-closure.md` (for the blocker codes)

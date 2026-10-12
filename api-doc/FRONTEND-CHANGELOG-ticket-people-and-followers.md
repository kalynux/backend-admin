# Admin dashboard — tickets now say WHO, and followers can be managed

> **Date:** 2026-10-10 · **Audience:** the admin dashboard · **Status:** built, **not deployed yet**
> **Breaking:** one response shape (the two follower writes). Everything else is additive.
>
> Full contract: [`api/support.md`](./api/support.md) — § *The people on a ticket*, § `followers`,
> § `POST /support/tickets/:ticketId/followers`, § `DELETE …/followers/:userId`.

Only `/api/v1/support/tickets*` changed. No new permission, no new route.

---

## 1. Who opened the ticket — a person, not a role

`createdBy` used to be `{ role, userId, administrator }`. On **both** the queue
(`GET /support/tickets`) and the detail (`GET /support/tickets/:ticketId`) it is now:

```ts
createdBy: {
  role: string;                 // customer | vendor | agency | agent | admin
  userId: string | null;        // users._id  → /users/:userId
  profileId: string | null;     // vendors._id / delivery_agencies._id / delivery_agents._id / customers._id
  name: string | null;          // the PERSON (for a vendor or agency: the contact person)
  businessName: string | null;  // the SHOP or the AGENCY; null for a customer or an agent
  phone: string | null;
  email: string | null;         // often null — a customer can register by phone alone
  administrator: AdminSnapshot | null;   // unchanged
}
```

`assignedTo` (the vendor / agency / agent a ticket was routed to) gained the same six fields.

| Do | Why |
|---|---|
| For `vendor` and `agency`, show **`businessName` as the title and `name` as the contact line**; fall back to `name` only when `businessName` is `null` | `name` is a human. Printing it under "Vendor" mislabels the row |
| Give every one of these fields a `null` fallback and still render the row (id + role) | They are looked up. A deleted profile or a closed, anonymised account resolves to nothing |
| Link the person: `/users/:userId`, or the role's own screen with **`profileId`** | `/vendors/:id`, `/agencies/:id` and `/agents/:id` take the profile id, **not** `userId` |
| For `role: "admin"`, show `name` only | An administrator (or "Wi-Mall (automatic)") has no phone, e-mail, profile or business. The fuller block is `createdBy.administrator` |

## 2. Followers — new on the DETAIL

`GET /support/tickets/:ticketId` now returns `followers[]`, oldest first. The queue row does
**not** carry it. Each entry is the person shape above (`userId` always set) plus:

```ts
source: 'creator' | 'assignee' | 'order_party' | 'admin' | null;  // null = row older than 2026-10-09
addedAt: string | null;       // ISO
isCreator: boolean;
isAssignee: boolean;
```

`order_party` means the platform added them automatically: on a ticket about an order (entity
type `ORDER` or `SHIPMENT`) the order's vendor and every agency and agent on its shipments follow
it, from the moment it opens or they are assigned. Show `source` as a small label
("Opened it" · "Assigned" · "Order party" · "Added by an administrator").

## 3. Add / remove a follower

| | |
|---|---|
| Add | `POST /support/tickets/:ticketId/followers` · body `{ userId, role }` (strict; `role` is `vendor` \| `customer` \| `agency` \| `agent`) |
| Remove | `DELETE /support/tickets/:ticketId/followers/:userId` |
| Permission | `support.tickets.followers.manage` — **all three tiers hold it** |

- **Every tier, on any ticket the administrator can open.** These two routes no longer depend on
  who holds the ticket. Show the controls to Developer, Admin and Support alike; do **not** gate
  them on `availableActions`.
- ⚠ **Both now answer the refreshed ticket detail** (the shape of `GET /:ticketId`, `followers`
  included). Before, add answered `data: undefined`. Replace your local ticket with the response;
  no refetch is needed.
- **Picking the user:** the body needs a `users._id` and one of that user's roles. Use
  `GET /users?search=<phone | e-mail | 24-hex id>&role=<role>` (`users.read`), then send the
  chosen `id` with the role you filtered on.
- **No limit applies** to a follower an administrator adds. Adding someone who already follows is
  a `200` that changes nothing.
- **Remove button:** hide it when `isCreator`, `isAssignee` or `role === "admin"` — jovi-mall
  refuses those three. Everyone else is removable.
- A removed follower is **not** re-added by the automatic order-party step. Adding them back by
  hand restores that.

### Errors to handle

| Status | `error.code` | `error.details.platformCode` | Show |
|---|---|---|---|
| 404 | `TICKET_NOT_FOUND` | – | The ticket is gone or outside this administrator's view |
| 404 | `PLATFORM_OPERATION_REJECTED` | `USER_NOT_FOUND` | "No user has this id" |
| 422 | `PLATFORM_OPERATION_REJECTED` | `TICKET_FOLLOWER_ROLE_MISMATCH` | "This user is not a <role>" — `details.roles` lists the roles they do hold |
| 403 | `PLATFORM_OPERATION_REJECTED` | `TICKET_ACCESS_DENIED` (remove) | "The creator, the current assignee and administrators cannot be removed" |
| 404 | `PLATFORM_OPERATION_REJECTED` | `TICKET_NOT_FOUND` (remove) | That user no longer follows the ticket — refresh |

## Checklist

- [ ] Queue: creator column shows name (+ business name for vendor/agency) and phone, not just the role
- [ ] Detail: creator card with name, phone, e-mail, user id, and a link to the user / role screen
- [ ] Detail: followers list with name, role, phone, `source` label, added date
- [ ] Add-follower dialog (user search → role → submit), visible to all three tiers
- [ ] Remove button, hidden on `isCreator` / `isAssignee` / `role === "admin"`
- [ ] After add/remove, replace the ticket from the response
- [ ] Every looked-up field has a `null` fallback

# `/support/tickets` — the support queue

Base path: `/api/v1/support/tickets`

The queue, the detail, assignment, lifecycle, followers, notes, attachments, and the two
reference lookups behind the creation form. **Nineteen routes**, and this is the **only**
administrative door onto tickets — jovi-mall's own `/api/admin/tickets` mount was deleted when
this one was built.

Design records: [`../../docs/PHASE-17-LEGACY-PORT-PLAN.md`](../../docs/PHASE-17-LEGACY-PORT-PLAN.md) (the port),
[`../../docs/ADR-004-DOMAIN-OWNERSHIP.md`](../../docs/ADR-004-DOMAIN-OWNERSHIP.md) (why the reads are direct
and the writes are not), [`../../docs/ADR-005-API-CONTRACT.md`](../../docs/ADR-005-API-CONTRACT.md) D-4, D-14,
D-17.

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/reference/orders` | `support.reference.read` | **delegated** | — |
| `GET` | `/reference/products` | `support.reference.read` | **delegated** | — |
| `DELETE` | `/attachments/:attachmentId` | `support.tickets.attachments.write` | **delegated** | ✅ |
| `GET` | `/` | `support.tickets.read` | direct read | — |
| `POST` | `/` | `support.tickets.create` | **delegated** | ✅ |
| `GET` | `/:ticketId` | `support.tickets.read` | direct read | — |
| `PATCH` | `/:ticketId` | `support.tickets.update` | **delegated** | ✅ |
| `PATCH` | `/:ticketId/status` | `support.tickets.update` | **delegated** | ✅ |
| `PATCH` | `/:ticketId/priority` | `support.tickets.update` | **delegated** | ✅ |
| `PATCH` | `/:ticketId/assign` | `support.tickets.assign` | **delegated** | ✅ |
| `POST` | `/:ticketId/claim` | `support.tickets.assign` | **delegated** | ✅ |
| `POST` | `/:ticketId/close` | `support.tickets.lifecycle` | **delegated** | ✅ |
| `POST` | `/:ticketId/reopen` | `support.tickets.lifecycle` | **delegated** | ✅ |
| `POST` | `/:ticketId/followers` | `support.tickets.followers.manage` | **delegated** | ✅ |
| `DELETE` | `/:ticketId/followers/:userId` | `support.tickets.followers.manage` | **delegated** | ✅ |
| `GET` | `/:ticketId/notes` | `support.tickets.notes.read` | **delegated** | — |
| `POST` | `/:ticketId/notes` | `support.tickets.notes.write` | **delegated** | ✅ |
| `GET` | `/:ticketId/attachments` | `support.tickets.attachments.read` | **delegated** + `fileId` | — |
| `POST` | `/:ticketId/attachments` | `support.tickets.attachments.write` | **delegated** | ✅ |

**Every tier holds every permission on this surface.** Support is where a Support-tier
administrator works, so the grant matrix is uniform and the narrowing happens *per record* —
see [§ Who sees what](#who-sees-what). That is the opposite of `/orders`, where the
interventions are withheld from Tier 3 by permission.

The writes split four ways on purpose — `update` for the content, `assign` for who holds it,
`lifecycle` for open/closed, `followers.manage` for who is on it. A single
`support.tickets.write` would mean anyone who can rename a ticket can also reassign it.

---

## Three things that are not obvious from the route list

### 1. `assigned_admin_id` was a LOCK, and it is gone

The legacy `/api/admin/tickets` mount had exactly one admin access rule: a field called
`assigned_admin_id`, auto-set on an administrator's **first action** on a ticket, which
thereafter answered `403` to **everybody else — Developers included**. It read like an
assignment and behaved like an exclusive lock, and it is the single most misreadable thing in
this module's history.

It is **not** what this surface does. Assignment here is explicit (`/assign`, `/claim`), it is
recorded, and it *removes* reach rather than granting it:

- the **unassigned pool** is actionable by **every** tier — that is what makes a queue move,
  and every system ticket (payout request, dispute, booking refund) starts there;
- assigning a ticket to a Tier 1 Developer takes it **out of** a Tier 2 Admin's reach;
- there is **no unassign**. A ticket leaves an administrator by being assigned onward. Dropping
  it back to the pool would be a way around the tier rules — drop it, let anyone claim it.

`test:support` § 2 asserts this as a table rather than describing it, for the same reason.

### 2. `avatarUrl` is reserved and always `null`

Every `AdminSnapshotDto` on this surface carries `avatarUrl`, and it is **`null` on every
response today, for every administrator**. This is a decision, not a gap (Phase 4 step 4.B.6.1
/ D-15, owner-confirmed 2026-08-20):

- `admin_accounts` stores no avatar, and wi-admin has **no write-side file surface at all** —
  its `files` module is two GETs delegating to jovi-mall, and there is no `multer` anywhere. An
  administrator picture would be this service's first upload path: a feature, with a storage
  decision, a permission, a route and a moderation question behind it.
- The field stays on the wire because the *stored* shape has it, and because jovi-mall's
  `PublicAdminSnapshot` — the projection a customer, vendor, agency or agent is shown —
  promises it too. Removing it here would shrink our copy of the promise, not the promise.

**Clients: render the initials fallback from `name`, and do not branch on this field.** The day
an avatar exists, `snapshotOf()` is the only line that changes and the field starts carrying a
URL — no wire change, no version bump.

### 3. The attachment delete is keyed on the ATTACHMENT, and its second read is load-bearing

`DELETE /support/tickets/attachments/:attachmentId` mirrors jovi-mall's own route shape: the
attachment id is the whole address, and the attachment row is the only thing that names its
ticket. So unlike every sibling on this surface, **the scope cannot be applied first — it has
to be reached.** The handler resolves the attachment to its ticket, then runs the same
scope-then-lock pair as every other write.

**Do not remove that lookup as redundant plumbing.** The gateway does take an attachment id, so
it *looks* removable; it is the only thing standing between this route and any attachment on
the platform. `test:support` § 7 asserts the order of the three calls.

---

## Who sees what

Three layers decide, in this order. They are separate because they fail differently.

| Layer | Question | A miss answers |
|---|---|---|
| **Permission** | may you do this kind of thing at all | `403 AUTHZ_PERMISSION_DENIED` |
| **Scope** | which tickets are yours to *see* | `404 TICKET_NOT_FOUND` |
| **Assignment lock** | may you *act* on this one | `403 AUTHZ_PERMISSION_DENIED` |

### The scope — a query, not a check

`resolveScope(identity, 'tickets')` becomes a Mongo clause folded into every read. A ticket
outside it is **not found**, so "not yours" and "does not exist" are one answer by
construction. A `403` there would confirm the ticket exists, which is exactly what somebody
mapping another tier's queue wants to learn.

| Tier | Sees |
|---|---|
| **1 Developer** | everything |
| **2 Admin** | their own **+** the unassigned pool **+** anything a Tier 3 holds |
| **3 Support** | their own **+** the unassigned pool. Not a peer's |

> **Tier numbers are inverted: 1 Developer is the *most* privileged, 3 Support the least.**

Tier 2 not seeing a Developer's tickets is deliberate: escalating to a Developer has to mean
something, and it means nothing if the person who escalated can still act afterwards. It is
also what stops a blanket "Support owns tickets" rule from handing Tier 3 indirect reach into
the payout queue, which is backed by `PAYOUT_REQUEST` tickets.

### The assignment lock — who may act

Applied to a ticket the scope already returned, so a refusal here is a `403` and says why.

| Caller | May act on |
|---|---|
| **1 Developer** | everything |
| **2 Admin** | their own, the unassigned pool, and anything a **Tier 3** holds |
| **3 Support** | their own, and the unassigned pool |

### The assignment authority — who may hand it to whom

| Caller | May assign to |
|---|---|
| **1 Developer** | 1, 2, 3 |
| **2 Admin** | 1 and 3 — **except** a ticket a Developer handed *them*, which may only go to 3 |
| **3 Support** | 2, and only a ticket they already hold |
| anyone, on an unassigned ticket | nobody — **claim it first** |

The Tier 2 exception keys on the **assigner's** tier, not the holder's, which is why the ticket
carries an `assignedBy` stamp at all. A Developer escalating downward and having it bounced
straight back is the loop it closes.

**Do not re-implement this table in a dashboard.** Every ticket carries `availableActions`,
derived from the same two functions the service enforces with — rendering a button from a
second copy of the rules is how a dashboard offers a verb the API refuses.

---

## `GET /support/tickets`

The queue.

| | |
|---|---|
| **Permission** | `support.tickets.read` |
| **Transport** | direct read |
| **Pagination** | `page` (≥ 1, default 1), `limit` (1–100, default 20) |
| **Sorting** | `createdAt`, `updatedAt`, `status`, `priority`. Default **`-createdAt`** |

`assignedAt` is deliberately **not** sortable. It lives inside the assignment block, which is
`null` for every unassigned ticket — and unassigned is not a rare edge here, it is the entire
pool. Sorting a list whose commonest state has no value for the sort key puts the queue in an
order nobody can predict.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Matches the **subject** (case-insensitive, contains). A **24-hex** term is read as a ticket id instead |
| `status` | token, 1–60 | **Format-validated, not pinned** — see below |
| `type` | token, 1–60 | |
| `priority` | token, 1–60 | |
| `importance` | token, 1–60 | |
| `entityType` | token, 1–60 | **A closed set of eleven at the platform** — see [The `entityType` vocabulary](#the-entitytype-vocabulary-is-closed-at-eleven) |
| `entityId` | string, 1–120 | |
| `queue` | `all` \| `mine` \| `unassigned` | Default `all`. **Narrows inside your scope; it can never widen it** |
| `from` / `to` | ISO-8601 instant | Creation range. **Max span 366 days** |

**There is no `assignedTo` parameter.** Whose queue you may read is the scope's decision, and a
parameter that could contradict it would be the one place the two disagree. The query schema is
non-strict, so sending one is **stripped, not refused** — it does not `400`, and it does not
reach the query either.

`queue=mine` and `queue=unassigned` are conveniences, not permissions: both are already subsets
of every scope this service produces, so the intersection is the point. An Admin asking for
`unassigned` and a Support administrator asking for the same get the same pool.

### The four status vocabularies are jovi-mall's

`status`, `type`, `priority` and `importance` are validated for **shape** — a 1–60 character
string — never for membership (ADR-005 D-17). jovi-mall owns all four and grows them with the
product; its ticket-type list alone has **39** values. A copy here would be a second list that
goes stale silently, and the failure mode of drift is a filter that matches nothing while
looking correct.

An unrecognised value therefore returns an **empty page**, not a `400`.

### The `entityType` vocabulary IS closed, at eleven

`entityType` is the exception to the paragraph above, and BR-016 § 7 asked the question
directly: **the token set is genuinely closed at the platform, not open.**

jovi-mall declares it as a TypeScript `enum EntityType` (`modules/tickets/types/ticket.types.ts`),
its ticket schema declares `entity_type: { enum: ENTITY_TYPE_VALUES, required: true }`, and both
its create and its list validators run `z.enum(ENTITY_TYPE_VALUES)` over the same array. There
is no write path by which a twelfth value can be stored.

| Value | Routable from the ticket alone? |
|---|---|
| `ORDER` | ✅ `orderId` |
| `SHIPMENT` | ✅ `shipmentId` |
| `PRODUCT` | ✅ **since BR-016 § 7** — needs `entity.vendorId`, which is now on the detail |
| `VENDOR` · `AGENT` · `AGENCY` · `USER` | ✅ each maps to a directory, the id is the parameter |
| `CUSTOMER` | ❌ **there is no customer directory** — see below. This row said ✅ until 2026-08-26 |
| `BOOKING` · `DELIVERY` | ❌ no administrative surface to link to |
| `OTHER` | ❌ names no entity by definition — jovi-mall lets `entityId` be omitted for it alone |

⚠ **This service still validates the token by SHAPE, not membership**, exactly as the four
vocabularies above: the enum is jovi-mall's to grow, and a pinned copy here is how a filter goes
stale silently. A client may rely on the eleven for **routing** and should still render an
unrecognised token as plain text.

#### ⚠ `CUSTOMER` is not routable, and this page claimed it was

**There is no customer screen on this service and no `/api/v1/customers` mount.**
`customers.read` was deleted at Phase 5 Part D (ADR-017 D-1) on the reasoning that
`GET /users?role=customer` answers the same question. That holds for *finding* a customer and
fails for *following a ticket's link*, because the two are keyed on different documents:

- the user directory is keyed on **`users._id`** — `GET /users/:userId`, and the search box's
  id branch matches `users._id` **only** (`user.read.repository.ts` § `searchClause`);
- a "customer id" in the platform's vocabulary is a **`customers._id`**, a separate document
  joined to a user by `customers.user_id`.

So a customer id pasted into the user directory returns an empty page rather than an error. The
row above put `CUSTOMER` beside four types that really do have a directory, and it was wrong.

**And nothing guarantees which of the two a ticket carries.** jovi-mall resolves `entityId`
for `ORDER`, `BOOKING` and `PRODUCT` only; every other type falls through
`validateEntityReference`'s default branch after an ObjectId **shape** check and is stored
unread (`ticket.service.ts`). A `CUSTOMER` ticket's `entityId` is whatever its creator sent,
so even a customer screen could not be routed to from it safely.

Render `CUSTOMER` as plain text, alongside `BOOKING` and `DELIVERY`. Two things on the same
ticket **are** routable and are usually the operator's actual destination:
`createdBy.userId` — a `users._id` whenever `createdBy.role` is not `admin`, so
`/users/:userId` behind `users.read` — and the `ORDER` or `SHIPMENT` a complaint about a
customer is normally filed against instead.

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66a1b2c3d4e5f60718293a4b",
      "subject": "Parcel marked delivered but never arrived",
      "type": "DELIVERY_ISSUE",
      "status": "open",
      "priority": "high",
      "priorityLocked": true,
      "importance": "normal",
      "entity": { "type": "ORDER", "id": "6670aabbccddeeff00112233", "vendorId": null, "label": null },
      "trackingNumber": "JM-2026-118842",
      "createdBy": {
        "role": "customer",
        "userId": "665f1c2a9b3e4a91c7d2e5f0",
        "administrator": null
      },
      "assignedTo": { "role": "agency", "userId": "6650aa11bb22cc33dd44ee55" },
      "assignment": {
        "admin": {
          "id": "66b0000000000000000000a1",
          "name": "Solange N.",
          "tier": 3,
          "jobTitle": "Support Specialist",
          "department": "Customer Care",
          "avatarUrl": null
        },
        "assignedBy": {
          "id": "66b0000000000000000000b2",
          "name": "Eric T.",
          "tier": 2,
          "jobTitle": "Operations Lead",
          "department": "Operations",
          "avatarUrl": null
        },
        "assignedAt": "2026-08-18T11:04:00.000Z"
      },
      "availableActions": { "claim": false, "assignableTiers": [2] },
      "terminalAt": null,
      "createdAt": "2026-08-17T08:12:00.000Z",
      "updatedAt": "2026-08-18T11:04:00.000Z"
    }
  ],
  "meta": { "total": 318, "page": 1, "limit": 20, "pages": 16 }
}
```

| Field | Notes |
|---|---|
| `priorityLocked` | jovi-mall's own flag: once an administrator sets a priority, the requester can no longer change it |
| `createdBy.administrator` | The **full** admin snapshot when an administrator opened the ticket on somebody's behalf, `null` otherwise. Same shape as `assignment.admin` |
| `assignedTo` | ⚠ **The platform actor the ticket was routed to** — a vendor, agency or agent. **This is not the administrator handling it.** That is `assignment` |
| `assignment` | `null` means the **unassigned pool** — a real state, not missing data |
| `assignment.assignedBy` | `null` when the ticket was **claimed** rather than handed over. The tier rules read its `tier` |
| `availableActions` | What **this caller** may do, derived from the same authority table the service enforces with |
| `terminalAt` | When the ticket reached a terminal status. Drives jovi-mall's attachment-cleanup clock |
| **`entity.vendorId` / `entity.label`** | ⚠ **Always `null` on the LIST.** They are resolved on the **detail only** — see [`GET /support/tickets/:ticketId`](#get-supportticketsticketid). A hundred-row page would be a hundred lookups across three collections to decorate a column that shows an id |

`description` is deliberately **absent from the list** — up to 700 characters of customer free
text, a hundred of them per page. [`GET /:ticketId`](#get-supportticketsticketid) adds it.

#### The administrator snapshot, in full

`tier` travels here and is dropped everywhere else. jovi-mall narrows the same stored block
through `publicAdminSnapshot()` before a customer, vendor, agency or agent sees it, dropping
`id`, `source` and above all `tier`. This is the administrator's own dashboard, so the whole
block travels — the tier is what the queue screen groups and filters by, and hiding it would
hide the thing the scope rules are about.

One stored block, narrowed at one boundary and not at the other. Not two stored blocks that
could disagree.

---

## `GET /support/tickets/:ticketId`

| | |
|---|---|
| **Permission** | `support.tickets.read` |
| **Transport** | direct read |

### Response (200)

The list item **plus `description`**, and with **`entity` resolved** — the two differences from
the queue row. Same mapper, same projection.

```jsonc
{
  "success": true,
  "data": {
    "id": "66a1b2c3d4e5f60718293a4b",
    "subject": "Parcel marked delivered but never arrived",
    "description": "The agent marked it delivered at 14:02 but nobody was home…",
    "entity": {
      "type": "PRODUCT",
      "id": "66601122334455667788990a",
      "vendorId": "6650aa11bb22cc33dd44ee55",
      "label": "Plantain — 1 kg"
    },
    "…": "…"
  }
}
```

#### Making `about` navigable

| Field | Notes |
|---|---|
| **`entity.vendorId`** | Set for **`type: "PRODUCT"` only**, `null` on every other type — those are not products, not "unknown vendors". It is what unblocks the link: a product's detail route is `/vendors/:vendorId/products/:productId` and needs **two** ids, where the ticket carries one. There is no vendor-agnostic product read anywhere on this service |
| **`entity.label`** | Something an operator recognises, where one read can supply it: the **order number** for `ORDER`, the **tracking number** for `SHIPMENT`, the **title** for `PRODUCT`. `null` for every other type and for a missing record. A convenience — never a substitute for the id, and never rendered in its place |

Both are `null` when the record is gone. A deleted listing is exactly what a catalogue complaint
tends to end in, so the ticket is served with no link rather than a fabricated one — and the
product lookup deliberately does **not** filter `deletedAt`, so a soft-deleted listing still
resolves and the ticket most worth reading is not the one with no link.

At most **one** query runs, dispatched on the type. Of the eight remaining types, **four**
(`USER`, `VENDOR`, `AGENT`, `AGENCY`) are resolved by the client from the type alone — each maps
to a directory — and the other four have no administrative surface to link to: `BOOKING`,
`DELIVERY`, `OTHER`, and **`CUSTOMER`, which has no directory on this service**. See the table
under [The `entityType` vocabulary](#the-entitytype-vocabulary-is-closed-at-eleven).

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `ticketId` is not 24-hex |
| **404** | `TICKET_NOT_FOUND` | No such ticket — **or it is outside your scope.** The two are indistinguishable by design |

---

## `POST /support/tickets`

Open a ticket on somebody's behalf.

| | |
|---|---|
| **Permission** | `support.tickets.create` |
| **Transport** | **delegated** |
| **Body** | **strict** — an unknown field is a `400` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `subject` | string | **Required.** 1–200 |
| `description` | string | **Required.** 1–700 |
| `type` | token | **Required.** 1–60. jovi-mall pins this to its own enum and refuses an unknown one |
| `importance` | token | **Required.** 1–60 |
| `entityType` | token | **Required.** 1–60 |
| `entityId` | string | 1–120. **Required by jovi-mall unless `entityType` is `OTHER`** |
| `trackingNumber` | string | Optional, 1–120 |
| `attachments` | array of 24-hex file ids | Optional, **max 5** |

**The creating administrator is not in the body.** It is read from your own `admin_accounts`
row and sent to jovi-mall as the snapshot, so "opened by" renders to the customer as a person
rather than a placeholder. A client-supplied name would let an administrator record somebody
else as handling a ticket; a client-supplied tier would decide who may subsequently see it.

Note the asymmetry: **the vocabularies are bounded strings here and enums at jovi-mall.** An
unknown `type` passes this validator and comes back as a `PLATFORM_OPERATION_REJECTED` naming
jovi-mall's code. That is the D-17 trade — a filter that silently matches nothing is worse than
a create that is refused with a reason.

### Response (201)

**jovi-mall's enriched ticket, passed through verbatim** — *not* the `TicketDto` above. It is
the platform's own creation payload, snake_case fields included. Re-read through
[`GET /:ticketId`](#get-supportticketsticketid) if you need this service's shape.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or over-long field, unknown key |
| 404 | `ADMIN_ACCOUNT_NOT_FOUND` | Your own administrator account was deleted mid-session |
| 400 / 409 / 422 | `PLATFORM_OPERATION_REJECTED` | jovi-mall refused — unknown `type` / `importance` / `entityType`, missing `entityId`, unusable file id. `details.platformCode` names which |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall unreachable or not configured |

### Audit

`support.tickets.create` — the payload records `subject`, `type` and `entityType`.

---

## `PATCH /support/tickets/:ticketId`

Edit the content.

| | |
|---|---|
| **Permission** | `support.tickets.update` |
| **Transport** | **delegated** |
| **Body** | **strict**, and **at least one field is required** |

| Field | Type | Rules |
|---|---|---|
| `subject` | string | 1–200 |
| `description` | string | 1–700 |

An empty body is a `400`, not an accepted no-op — a no-op that writes an audit row is a lie in
the trail.

### Response (200)

jovi-mall's enriched ticket, passed through.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Empty body, unknown key, over-long field |
| 404 | `TICKET_NOT_FOUND` | Not found, or outside your scope |
| **403** | `AUTHZ_PERMISSION_DENIED` | **The assignment lock** — you can see this ticket, but another administrator holds it |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`support.tickets.update`

---

## `PATCH /support/tickets/:ticketId/status`

| | |
|---|---|
| **Permission** | `support.tickets.update` |
| **Transport** | **delegated** |
| **Body** | `{ "status": "<token>" }`, strict |

Status, priority and the content edit are **three sub-resources rather than three fields on one
PATCH** (ADR-005 D-4): the permission and the audit row attach to the *action*, and folding
them into one body would produce one audit row that cannot say which of them happened.

`status` is format-validated here and **pinned at jovi-mall**, which owns the state machine. An
invalid transition or an unknown value comes back as `PLATFORM_OPERATION_REJECTED`.

Errors are those of [`PATCH /:ticketId`](#patch-supportticketsticketid), plus a `409 / 422`
`PLATFORM_OPERATION_REJECTED` for a refused transition.

### Audit

`support.tickets.status.set`

---

## `PATCH /support/tickets/:ticketId/priority`

| | |
|---|---|
| **Permission** | `support.tickets.update` |
| **Transport** | **delegated** |
| **Body** | `{ "priority": "<token>" }`, strict |

⚠ **This is one-way in effect.** jovi-mall sets `priority_locked` when an administrator changes
a priority, and the requester can no longer change it afterwards. Read `priorityLocked` on the
ticket before offering the control.

### Audit

`support.tickets.priority.set`

---

## `PATCH /support/tickets/:ticketId/assign`

Hand the ticket to another administrator.

| | |
|---|---|
| **Permission** | `support.tickets.assign` |
| **Transport** | **delegated** |
| **Body** | **strict** |

| Field | Type | Rules |
|---|---|---|
| `administratorId` | 24-hex | **Required.** A wi-admin `admin_accounts` id — **not** a platform `users` id |

**The body names the target and nothing else.** Who is assigning is the authenticated caller,
and the target's **tier is read from their own record**, never from the request — it decides,
through the scope, who may subsequently see the ticket.

The target must be an **active** administrator. An inactive or unknown one answers
`404 TICKET_NOT_FOUND` — the same code and message as an out-of-scope ticket, so this endpoint
cannot be used to enumerate administrator ids.

### Response (200)

jovi-mall's enriched ticket, carrying the new assignment block.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Not 24-hex, or an unknown key (`tier`, `assignedBy`) |
| 404 | `TICKET_NOT_FOUND` | The ticket, **or** no active administrator with that id |
| 403 | `AUTHZ_PERMISSION_DENIED` | The assignment lock, **or** the target's tier is not in your `availableActions.assignableTiers` |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`support.tickets.assign` — the payload records `administratorId` and `administratorTier`.

---

## `POST /support/tickets/:ticketId/claim`

Take an unassigned ticket for yourself.

| | |
|---|---|
| **Permission** | `support.tickets.assign` |
| **Transport** | **delegated** |
| **Body** | **empty**, strict — the caller *is* the target |

**Its own route, not `assign` pointed at yourself.** It records a different audit action, takes
no target, and above all it is open to **every tier** where assignment is not: a Support
administrator may claim from the pool but may only ever *assign* upward to Tier 2. One endpoint
would have to encode that as a special case.

**A claim records no `assignedBy`**, and that absence is meaningful — the Tier 2 rule reads
`assignedBy.tier` to decide where a ticket may go next.

Check `availableActions.claim` before offering the button.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A non-empty body |
| 404 | `TICKET_NOT_FOUND` | |
| **409** | `TICKET_ALREADY_ASSIGNED` | Somebody already holds it |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`support.tickets.claim`

---

## `POST /support/tickets/:ticketId/close` · `POST /support/tickets/:ticketId/reopen`

| | |
|---|---|
| **Permission** | `support.tickets.lifecycle` |
| **Transport** | **delegated** |
| **Body** | **empty**, strict — the act is the whole statement |

Closing sets `terminalAt`, which starts jovi-mall's attachment-cleanup clock. A **closed ticket
refuses new notes** (`409` from jovi-mall) — reopen first.

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `TICKET_NOT_FOUND` | |
| 403 | `AUTHZ_PERMISSION_DENIED` | The assignment lock |
| 409 / 422 | `PLATFORM_OPERATION_REJECTED` | Already closed, already open |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`support.tickets.close` · `support.tickets.reopen` — a different act gets a different name.

---

## `POST /support/tickets/:ticketId/followers`

| | |
|---|---|
| **Permission** | `support.tickets.followers.manage` |
| **Transport** | **delegated** |
| **Body** | **strict** |

| Field | Type | Rules |
|---|---|---|
| `userId` | 24-hex | **Required.** A platform `users` id |
| `role` | `vendor` \| `customer` \| `agency` \| `agent` | **Required. Pinned** — administrators are not followers |

Followers are **platform actors**, not administrators. The four-value enum is pinned precisely
because `admin` must not be expressible: an administrator's relationship to a ticket is the
assignment, and a private note's visibility list is computed from the *follower* rows.

### Audit

`support.tickets.followers.add`

---

## `DELETE /support/tickets/:ticketId/followers/:userId`

| | |
|---|---|
| **Permission** | `support.tickets.followers.manage` |
| **Transport** | **delegated** |

Both path parameters must be 24-hex.

### Audit

`support.tickets.followers.remove`

---

## `GET /support/tickets/:ticketId/notes`

| | |
|---|---|
| **Permission** | `support.tickets.notes.read` |
| **Transport** | **delegated** |

Scoped first: the ticket is loaded through your scope before the delegation, so an out-of-scope
ticket is a `404` and no note leaves jovi-mall.

### Response (200)

**jovi-mall's enriched notes, passed through verbatim** — author identity resolved, snake_case
included. Administrators see **all** notes on a ticket they may read, private ones included.

---

## `POST /support/tickets/:ticketId/notes`

| | |
|---|---|
| **Permission** | `support.tickets.notes.write` |
| **Transport** | **delegated** |
| **Body** | **strict** |

| Field | Type | Rules |
|---|---|---|
| `content` | string | **Required.** 1–**300**. jovi-mall's own limit, mirrored here so the refusal is a local `400` rather than a pass-through |
| `isPublic` | boolean | **Defaults to `false`** |

### `isPublic` is the customer-visibility switch, and `false` is the safe default

`false` files the note **private**: the author, every administrator following the ticket, and
nobody else. `true` shows it to every follower — which means **the customer**. The default is
the safety property: these are staff notes on somebody's support case, and the failure
direction of a missing flag must be "the customer does not see it".

> ⚠ **This was not true before 2026-08-20.** jovi-mall names the field `visibility`
> (`'public' | 'private'`, defaulting to **public**) and its schema is non-strict, so
> `isPublic` was *stripped in transit* and **every note this service created was filed
> public** — a `201`, no warning, the customer reading staff commentary. Fixed at Phase 4
> step 21 by translating at the gateway. `test:support` § 6 asserts the **translation**, not
> the parameter, because a test that only checked that `isPublic` reaches the gateway is
> exactly the test that passed while the defect was live.

### Response (201)

jovi-mall's enriched note, passed through.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Empty content, over 300 characters, unknown key |
| 404 | `TICKET_NOT_FOUND` | |
| 403 | `AUTHZ_PERMISSION_DENIED` | The assignment lock |
| 409 | `PLATFORM_OPERATION_REJECTED` | **The ticket is closed** — reopen before noting |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`support.tickets.notes.create` — the payload records `isPublic` and the content **length**.

**The note's text is deliberately not in the audit row.** It is staff commentary on somebody's
support case, the note row is itself the durable record, and copying it into the compliance
trail duplicates personal data into a store with a different retention rule. What is recorded
is that a note was added, and whether it was public.

---

## `GET /support/tickets/:ticketId/attachments`

| | |
|---|---|
| **Permission** | `support.tickets.attachments.read` |
| **Transport** | **delegated**, plus one field this service adds — see `fileId` below |

### Response (200)

jovi-mall's attachment list, passed through — `id`, `fileName`, `fileSize`, `mimeType`, `url`,
`uploadedBy`, `uploadedByRole`, `uploadedByActor`, `createdAt` — with `fileId` added by this
service.

| Field | Type | Notes |
|---|---|---|
| `fileId` | 24-hex string \| null | The jovi-mall **File** id behind the attachment — the same id `POST` takes, and the id to hand to [files.md](files.md)'s resolver for a `FileDetail`. `id` is the ATTACHMENT, not the file; the two are different documents and only `fileId` addresses the file. |

`fileId` is **not** part of jovi-mall's payload. wi-admin reads it from the attachment row in
the shared database and stamps it onto each row, because it needs no machinery to resolve —
unlike `url`, which is why the rest of the row is delegated (ADR-018 D-4). Requesting it from
jovi-mall would have been a release there; this was a one-service change.

It is `null` only in a race — the attachment was deleted between jovi-mall answering and this
service reading. The key is always present, so a client may read it unconditionally.

### `uploadedByActor` — the uploader as a person, and the one role it cannot name

**Undocumented on this page until 2026-08-26, and on the wire since the ticket module was
built.** It is jovi-mall's resolved uploader summary, the same `ActorSummary` object the notes'
`author` carries, produced by `TicketEnrichmentService.enrichAttachments`. Both `GET` and
`POST` return it.

| Field | Type | Notes |
|---|---|---|
| `user_id` | 24-hex string | The same value as the sibling `uploadedBy` |
| `role` | `customer` · `vendor` · `agency` · `agent` · `admin` | The same value as the sibling `uploadedByRole` |
| `name` | string | The uploader's display name — **or a placeholder, below**. For `vendor` / `agency` it is the business's, from the Store / Magazin |
| `avatar` | `FileDetail` or `null` | Their picture, or the business logo. The shape in [files.md](files.md) § *What a resolved file looks like* — so its own `url` may be `null` |

⚠ **`uploadedByActor` is snake_case inside**, unlike every ticket field around it. The ticket
rows on this surface are **this service's** projection (`createdBy.userId`, camelCase); the
attachment list is jovi-mall's own payload passed through, and its inner objects were never
renamed. Read `uploadedByActor.user_id`, not `.userId`.

`null` only when the row carries no uploader, which the schema makes required — treat it as
"unknown", never as an error.

#### ⚠ For `role: "admin"` the `name` is the literal `"Admin"`

Never the administrator's name, and that is the case a dashboard most wants. An administrator
has **no `users` row and no `admins` row in `jovi_mall`** (ADR-004 D-1, the synthetic actor):
the id jovi-mall stores is the `X-Actor-Id` this service sent, an `admin_accounts._id` out of
**this** database. jovi-mall's resolver looks it up in its own `admins` collection, matches
nothing, and falls back to the capitalised role.

The same fallback produces `"Customer"`, `"Vendor"`, `"Agency"` or `"Agent"` when a profile
has been deleted — so **a `name` equal to the capitalised `role` is the signal that nothing
resolved**, and it is the only signal there is. `avatar` is `null` in that case too.

**The same placeholder appears on note authors**, for the same reason and with no other
symptom: an administrator's note renders `author.name: "Admin"`.

Resolving it would be **this service's** job, not jovi-mall's — `uploadedBy` is an
`admin_accounts._id` and [`GET /administrators/:adminId`](administrators.md) resolves exactly
that. It is deliberately not wired: that route needs `administrators.read`, and **Support does
not hold it** (`tier-grants.ts`: *"no sight of the administrator directory"*) — Support being
the tier that reads tickets. The write path *does* know the name, in `X-Actor-Name`, and drops
it; a snapshot on the attachment row, like the one `assignment.admin` already carries, is what
would close this. Ask for it rather than building a lookup Support cannot make.

**For every other role `user_id` IS a `users._id`** and routes to
[`GET /users/:userId`](users.md) behind `users.read`, which Support does hold.

⚠ **The `url` is a permanent, unauthenticated public URL — it does not expire.** This page
said the opposite until BR-010 ("do not cache it past its expiry"), and the correction matters
in the unsafe direction: the old wording invited a reader to treat the link as
self-limiting when nothing limits it.

`url` here is `storage.getPublicUrl(key)` on the file's stored key, computed per request from
the active provider. It is not a signed URL, it carries no expiry, and fetching it needs no
session. Attachments land in `documents/` or `images/` — both **public** storage trees — so
this is not a gap in this route but a property of how attachments are stored. See
[files.md](files.md) § *Support-ticket attachments are public*.

**Treat an attachment URL as a shareable secret.** Anyone it reaches can fetch the file
indefinitely.

Note this list is **not** a `FileDetail`: it is the attachment row's own shape, with `url` as
a plain `string` and no `access` field. A `FileDetail` resolved from the same underlying file
id via [files.md](files.md) would report `access: "public"` and the same URL.

---

## `POST /support/tickets/:ticketId/attachments`

| | |
|---|---|
| **Permission** | `support.tickets.attachments.write` |
| **Transport** | **delegated** |
| **Body** | **strict** |

| Field | Type | Rules |
|---|---|---|
| `fileId` | 24-hex | **Required.** An already-uploaded jovi-mall file id |

**This service accepts no multipart bodies anywhere** — the upload happens against jovi-mall,
and this endpoint attaches the resulting id. See [files.md](files.md).

### Response (201)

jovi-mall's enriched attachment, passed through — the same row the list returns, including
[`uploadedByActor`](#uploadedbyactor--the-uploader-as-a-person-and-the-one-role-it-cannot-name).

⚠ **`fileId` is NOT stamped on this response**, unlike the list. You already hold it — it is
what you sent — so this is a difference to know rather than a gap to work around.

### Audit

`support.tickets.attachments.attach`

---

## `DELETE /support/tickets/attachments/:attachmentId`

Remove an attachment. **Keyed on the attachment, and declared before `/:ticketId`** so Express
does not read the literal `attachments` as a ticket id.

| | |
|---|---|
| **Permission** | `support.tickets.attachments.write` |
| **Transport** | **delegated** |

### The three reads, in order

1. `findTicketIdByAttachment` — resolves the attachment to its owning ticket. Projects exactly
   `{_id, ticket_id}`: an attachment on a ticket you may not see is precisely the row whose
   `fileName` and `visibleToUserIds` must not leave the database.
2. `loadScoped` — the **tier scope**, on that ticket. A miss is `404`.
3. `assertMayAct` — the **assignment lock**. A miss is `403`.

Step 1 is what makes steps 2 and 3 possible. It is not plumbing —
see [§ 3 above](#3-the-attachment-delete-is-keyed-on-the-attachment-and-its-second-read-is-load-bearing).

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Not 24-hex |
| **404** | `TICKET_NOT_FOUND` | No such attachment, **or** its ticket is outside your scope — **identical code and identical message**, so the two are indistinguishable. Two 404s differing only in `error.code` are still an existence oracle |
| 403 | `AUTHZ_PERMISSION_DENIED` | The assignment lock |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`support.tickets.attachments.delete` — the target is the **attachment id**, and the row carries
no ticket label. It is the one write on this surface whose target cannot be resolved to a
ticket without a second read.

---

## `GET /support/tickets/reference/orders` · `GET /support/tickets/reference/products`

The two lookups behind the ticket-creation form.

| | |
|---|---|
| **Permission** | `support.reference.read` |
| **Transport** | **delegated** |
| **Audited** | no — nothing on this path decides anything |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Optional. Forwarded to jovi-mall as its `q` parameter |

> The translation is not cosmetic: jovi-mall reads `q`, this service's parameter is `search`,
> and until Phase 4 step 21 the value was forwarded under the wrong name and **ignored** — so
> the type-ahead answered the unfiltered first page while looking as though it had searched.

**Unscoped.** Delegated as `role: 'admin'`, which jovi-mall treats as an empty filter: every
order, every product. That is what a ticket-creation form needs, and it is why the permission
is its own (`support.reference.read`) rather than `support.tickets.read` — the scope that
governs *tickets* does not apply here and would be misleading if it appeared to.

### Response (200)

jovi-mall's array, passed through. **Page size is jovi-mall's, capped at 50, and its pagination
metadata is not forwarded** — `data` is the array alone. These are type-ahead lookups; page
through the real [`/orders`](orders.md) surface if you need a directory.

---

## Delegation, in one paragraph

**Every read on this surface that returns a *record* is a direct read of `jovi_mall`; every
write is delegated over `/api/internal/admin/tickets/*`.** That split is ADR-004's rule, and
here the reason is concrete rather than precautionary: jovi-mall creates tickets **in-process**
from the payout-request, dispute and booking-refund paths, and every ticket write publishes on
its in-process event bus (`ticket.created`, `ticket.assigned`, `ticket.status_changed`,
`ticket.priority_changed`). A second writer would move the row and notify nobody — the customer
waiting on the ticket simply never hears.

The notes, the attachment lists and the reference lookups are **reads that are still
delegated**, because they are jovi-mall's own enrichment (a note joined to its author, an order
joined to its customer), and a second implementation of a projection that exists to render one
form is a projection that will disagree.

### The snapshot refresh you never call

Every mutation on this surface also fires a **best-effort** `PATCH /tickets/:id/admin-snapshot`
against jovi-mall, re-stamping the current assignee's name, tier, job title and department. It
answers "who is handling this **now**", so a stale name is a wrong answer rather than a
historical record.

It is **not** on this API, it is **never audited**, and it **cannot fail your request** — a
ticket update that succeeded must not report failure because a cosmetic name refresh did. A
failure is logged at `warn` with the ticket id, the holder id and the error.

⚠ **It does not ride `/assign`**, and that is load-bearing: sending a bare `admin` there means
"this administrator now holds it, claimed", which would reassign the ticket on every edit and
clear `assignedBy` — the field the Tier 2 rule depends on.

---

## Error codes on this surface

| Code | Status | Category | Meaning |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | `validation` | Bad path parameter, unknown body key, bound violated |
| `AUTHZ_PERMISSION_DENIED` | 403 | `authorization` | The permission, **or the assignment lock** |
| `TICKET_NOT_FOUND` | 404 | `not_found` | No such ticket — **or it is outside your scope, or no such attachment, or no active administrator with that id** |
| `TICKET_ALREADY_ASSIGNED` | 409 | `conflict` | Claiming a ticket somebody already holds |
| `ADMIN_ACCOUNT_NOT_FOUND` | 404 | `not_found` | Your own account vanished mid-session (a concurrent deletion) |
| `PLATFORM_OPERATION_REJECTED` | 4xx | varies | jovi-mall refused the delegated write. `details.platformCode` carries its code |
| `SERVICE_DEPENDENCY_UNAVAILABLE` | 502 / 503 | `external_service` | jovi-mall unreachable, 5xx, or `JOVI_MALL_BASE_URL` unset |

**`TICKET_NOT_FOUND` is deliberately overloaded.** Four different situations answer it with the
same message, and collapsing them is the point — a distinct code for each would let a
Support-tier administrator learn which of them applied.

See [errors.md](errors.md) for the envelope, the nine categories and the exposure rule.

---

## What this surface deliberately does not offer

| Verb | Why not |
|---|---|
| **Unassign** | A ticket leaves an administrator by being assigned onward, which the tier rules govern. Returning one to the pool would be a way around them: drop it, let anyone claim it |
| **Delete a ticket** | jovi-mall soft-deletes on its own schedule and the attachment-cleanup worker keys off the terminal-status clock. A delete from here would strand it |
| **Edit or delete a note** | A note is an append-only record of what was said |
| **Upload a file** | This service accepts no multipart bodies. Upload against jovi-mall, then attach the id |
| **Read another administrator's queue by parameter** | The scope decides that. See [§ Who sees what](#who-sees-what) |

# Permissions and administrator levels

This is the complete authorization policy. It is **static code**, not data: there are no
per-administrator overrides, no policy collections, and nothing is editable at runtime.
Changing what a level can do means shipping a release.

Design records: [`../ADR-003-GRANULAR-PERMISSIONS.md`](../ADR-003-GRANULAR-PERMISSIONS.md),
[`../ADR-001-DATA-ACCESS-MODEL.md`](../ADR-001-DATA-ACCESS-MODEL.md).

---

## The three levels

**Lower number = more privilege.** This trips people up; it is worth saying twice.

| Level (`tier`) | Label | Holds | Shape of the job |
|---|---|---|---|
| **1** | Developer | 116 of 116 | Everything, including the developer tools and every escalation-flagged action |
| **2** | Admin | 99 of 116 | The operational tier — runs the platform day to day, including the money |
| **3** | Support | 30 of 116 | Ticket work, the lookups needed to answer a ticket, and editorial write on articles and bylines. Nothing financial, nothing destructive, and publishing stays a level above |

A level is an administrator's **entire** authorization state. `tier` appears on the profile
returned by `GET /auth/me`.

### What a client should do with this

Call `GET /api/v1/permissions/me` after login and build navigation from the returned set.
Do not hard-code the matrix below into the dashboard, and do not discover capability by
collecting 403s.

---

## How a decision is made

Four layers, in order. Each can refuse independently.

```
authentication → permission → escalation rules → resource scope
   who are you      may you        may you do it        which records
                                   to THIS admin        are yours to see
```

1. **Permission.** The route declares one or more permission names, in `all` mode (holds
   every one) or `any` mode (holds at least one). A miss is `403 AUTHZ_PERMISSION_DENIED`
   with `details.required` and `details.mode`.

2. **Escalation rules** — only on administrator-on-administrator actions:

   | Refusal | Code | Rule |
   |---|---|---|
   | Acting on yourself | `AUTHZ_SELF_ACTION_FORBIDDEN` | Suspending, demoting or resetting your own account is refused whatever you hold |
   | Acting upward | `AUTHZ_TARGET_TIER_PROTECTED` | The target is at or above your own level |
   | Minting a peer | `AUTHZ_TIER_ESCALATION_FORBIDDEN` | Assigning a level at or above your own |

   The messages name the **rule**, never the caller's standing — "administrators at or above
   your own level", not "you are tier 2 and the target is tier 1".

3. **Resource scope** — row-level narrowing on two resource classes. A scope miss is a
   **404, not a 403**: a 403 would confirm the record exists, which is exactly what someone
   probing for another administrator's record wants to learn.

   | Resource | Levels 1 & 2 | Level 3 (Support) |
   |---|---|---|
   | `audit` | Everything | Platform activity (users, vendors, agencies, agents, orders, shipments, tickets, the COD cash chain) **plus their own actions**. Rows about this service's own machinery — administrators, sessions, approvals, exports — are invisible |
   | `tickets` | The whole board | Their own tickets plus the unassigned queue |

4. **Dual control** — see below.

---

## Dual control (four eyes)

Three actions are **queued instead of executed** when a condition holds. The endpoint answers
**`202 Accepted`** with an approval id; a **different** administrator holding the approver
permission commits it through `/approvals`.

| Action | Queued when | Approver must hold | Not queued |
|---|---|---|---|
| `PUT /administrators/:adminId/tier` | The requested tier is **1 (Developer)** | `administrators.tier.set` | Any demotion, or promotion to 2 / 3 |
| `POST /administrators/:adminId/suspend`<br>`POST /administrators/:adminId/reinstate` | The **target** is a Developer | `administrators.suspend` | Acting on an Admin or Support administrator |
| `POST /money/payouts/:payoutId/mark-paid` | Amount **≥ 2 000 000 XAF** | `money.payouts.mark_paid` | Below the threshold; and **rejecting** a payout is never queued |

Three properties a client should rely on:

- The approver **cannot be the requester** — `403 AUTHZ_APPROVAL_SELF_APPROVAL`.
- Requests expire after `ADMIN_APPROVAL_TTL_S` (default **24 h**) — `409 AUTHZ_APPROVAL_EXPIRED`.
- The precondition is **re-checked at approval time**. A payout resolved while the request sat
  in the queue is refused with `PAYOUT_NOT_PENDING` rather than paid twice.

Quorum sits on the **irreversible** direction only. Marking a payout paid asserts money has
left the platform and nothing can undo it; rejecting returns it to the owner's balance and they
can ask again. The same reasoning keeps demotion out of the tier rule.

See [authorization.md](authorization.md) for the `/approvals` endpoints.

---

## The four sensitivity flags

A permission carrying any of these is **sensitive**, and sensitivity has two mechanical
consequences: it can never be acquired by a family-wide grant (a human must type its name),
and the boot-time grant assertion enforces the level restrictions below.

| Flag | Meaning | Enforcement |
|---|---|---|
| `financial` | Moves money, changes a record money is computed from, **or discloses a payment destination** | **Refused to Support (tier 3) at boot** |
| `escalation` | Changes who is an administrator or what level they hold | **Developer (tier 1) only, at boot** |
| `destructive` | Irreversible, or reversible only by hand | Never granted by family expansion |
| `dual-control` | Queued for a second administrator | Never granted by family expansion |

There is no wildcard grant anywhere in the policy. A `'*'` would silently hand a level every
permission added in future, including one written next quarter for a job nobody has thought
about yet.

`money.payouts.destination.read` is the flag's edge case worth knowing: it is a **read** that
carries `financial`, because its *output* is the material a fraudulent payout instruction is
built from. `money.earnings.read` and `cod.overview.read` are unflagged and belong that way —
do not reach for `financial` merely because a read concerns money.

### Three reads are audited, and two of them are held by Support

"Reads are not actions" is the rule, and it holds because a read leaves no state behind — so the
permission gate is the whole control and a row per read would be volume with nothing to say.
**Three permissions break it**, all for the same reason: their *output* **is** the disclosure.

| Permission | What it discloses | Held by Support |
|---|---|:-:|
| `money.payouts.destination.read` | A beneficiary's account number | no (`financial`) |
| `agents.tracking.read` | Where a person is, right now | **yes** |
| `shipments.tracking.read` | Where a person went, over one delivery | **yes** |

For a disclosure, "who *may*" is not the interesting question; **"who *did*, and how often"** is.
An administrator who unmasks forty positions in an afternoon is doing something other than
answering tickets, and nothing else in this service would ever see it.

The two tracking permissions are **unflagged** and reach Support deliberately — *"where is my
delivery right now"* is what a ticket asks, and refusing it to the tier that answers tickets
escalates every one of them. **The audit is the other half of that decision**: on every
coordinate-emitting read the row commits **before** the disclosure and its failure is not caught,
so with the audit store unreachable nothing is disclosed. Widening the audience and adding the
record were one decision, not two. See [ADR-020](../ADR-020-ADMIN-DATA-DOOR.md) D-5.

---

## The matrix

● granted  ·  not granted  ·  **†** = catalogued policy with **no endpoint built yet**
(**4** of 116 permissions — down from 27, and the four that remain each have a written reason
below. The policy is decided ahead of the surface, deliberately.)

### `agents`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `agents.read` | read | ● | ● | ● | — | View delivery agents, their history, COD allocation, tracking policy and eligibility |
| `agents.status.set` | write | ● | ● | · | — | Activate or suspend an agent (a reason is required to suspend) |
| `agents.ban` | write | ● | ● | · | destructive | Permanently ban an agent from the platform |
| `agents.kyc.review` | write | ● | ● | · | — | Approve or reject an agent’s identity documents — this is what lets an agent work |
| `agents.tracking.set` | write | ● | ● | · | — | Override an agent’s live-location tracking permission |
| `agents.tracking.read` | read | ● | ● | ● | — | Read an agent’s live tracking state and live position from geo-tracker — every position read is recorded in the audit trail |
| `agents.cod_threshold.set` | write | ● | ● | · | financial | Set how much cash on delivery an agent may hold before remitting |
| `agents.transfer` | write | ● | ● | · | — | Move an agent from one delivery agency to another |
| `agents.contracts.manage` | write | ● | ● | · | — | Suspend, reinstate or terminate one agent↔agency contract (never its terms) |

### `agencies`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `agencies.read` | read | ● | ● | ● | — | View delivery agencies and their details |
| `agencies.verify` | write | ● | ● | · | — | Approve a delivery agency’s business verification — this is what lets a pending agency operate |
| `agencies.deactivate` | write | ● | ● | · | destructive | Deactivate a delivery agency — cascades a suspension across every vendor product that defaults to it |
| `agencies.reactivate` | write | ● | ● | · | — | Reactivate a previously deactivated delivery agency |

### `billing`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `billing.plans.read` | read | ● | ● | · | — | View subscription plans |
| `billing.plans.manage` | write | ● | ● | · | — | Create and edit subscription plans |
| `billing.plans.delete` | write | ● | ● | · | destructive | Delete a subscription plan |
| `billing.subscriptions.assign` | write | ● | ● | · | financial | Assign a plan to a vendor, agency or agent — changes what they are billed |

### `cod`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `cod.overview.read` | read | ● | ● | · | — | View the cash-on-delivery position across the platform |
| `cod.remittances.read` | read | ● | ● | · | — | View cash remittances declared by agencies |
| `cod.remittances.confirm` | write | ● | ● | · | financial | Confirm a cash remittance — settles collections FIFO and unlocks the agency’s earnings |
| `cod.remittances.reject` | write | ● | ● | · | financial | Reject a declared cash remittance |
| `cod.deposits.read` | read | ● | ● | · | — | View cash deposits paid directly to the platform |
| `cod.deposits.create` | write | ● | ● | · | financial | Record cash received directly from an agent or agency |
| `cod.deposits.confirm` | write | ● | ● | · | financial | Confirm a recorded cash deposit |
| `cod.deposits.reject` | write | ● | ● | · | financial | Reject a recorded cash deposit |
| `cod.discrepancies.read` | read | ● | ● | · | — | View cash discrepancies raised against agents and agencies |
| `cod.discrepancies.resolve` | write | ● | ● | · | financial | Resolve a cash discrepancy, deciding who absorbs the shortfall |
| `cod.holders.read` | read | ● | ● | · | — | View which agents and agencies are currently holding platform cash |
| `cod.trust.adjust` | write | ● | ● | · | financial | Manually adjust an agent’s cash trust score, changing how much they may carry |

### `money`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `money.earnings.read` | read | ● | ● | · | — | View platform earnings and the earnings ledger |
| `money.payouts.read` | read | ● | ● | · | — | View the payout request queue |
| `money.payouts.mark_paid` | write | ● | ● | · | financial, dual-control | Mark a payout request as paid — records that money has left the platform |
| `money.payouts.reject` | write | ● | ● | · | financial | Reject a payout request |
| `money.payouts.destination.read` | read | ● | ● | · | financial | Reveal the full payout destination (account or mobile number) on one payout request — every reveal is recorded in the audit trail |
| `money.payments.read` | read | ● | ● | ● | — | View gateway payment and refund settlements |

### `orders`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `orders.read` | read | ● | ● | ● | — | Search orders and view an order’s detail and timeline |
| `orders.disputes.read` | read | ● | ● | ● | — | View the order dispute queue |
| `orders.disputes.resolve` | write | ● | ● | · | financial | Resolve an order dispute, deciding who is paid |
| `orders.intervene` | write | ● | ● | · | — | Manually change an order’s state to unblock it |
| `orders.refund` | write | ● | ● | · | financial | Refund an order, in full or in part |

### `support`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `support.errors.lookup` | read | ● | ● | ● | — | Look up an error a vendor, agency, agent or customer hit, by its reference |
| `support.tickets.read` | read | ● | ● | ● | scoped:tickets | View support tickets |
| `support.tickets.create` | write | ● | ● | ● | — | Open a support ticket on someone’s behalf |
| `support.tickets.update` | write | ● | ● | ● | scoped:tickets | Edit a ticket’s subject, body, status or priority |
| `support.tickets.assign` | write | ● | ● | ● | — | Assign a ticket to an administrator, or take it from the unassigned queue |
| `support.tickets.lifecycle` | write | ● | ● | ● | scoped:tickets | Close and reopen tickets |
| `support.tickets.followers.manage` | write | ● | ● | ● | scoped:tickets | Add and remove ticket followers |
| `support.tickets.notes.read` | read | ● | ● | ● | scoped:tickets | Read internal notes on a ticket — never visible to the customer |
| `support.tickets.notes.write` | write | ● | ● | ● | scoped:tickets | Add an internal note to a ticket |
| `support.tickets.attachments.read` | read | ● | ● | ● | scoped:tickets | View files attached to a ticket |
| `support.tickets.attachments.write` | write | ● | ● | ● | scoped:tickets | Attach a file to a ticket, or remove one |
| `support.reference.read` | read | ● | ● | ● | — | Look up the orders and products a ticket can reference |

### `content`

Fourteen routes at `/api/v1/content` since Phase 5 Part A — the one ported family that **moved
ownership** rather than delegating. This service writes `articles` and `article_authors`
directly; jovi-mall keeps the Mongoose schema, the indexes and the public reader. Full contract
in [content.md](content.md).

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `content.articles.read` | read | ● | ● | ● | — | View and preview articles, published or not |
| `content.articles.write` | write | ● | ● | ● | — | Create and edit articles |
| `content.articles.publish` | write | ● | ● | · | — | Publish, unpublish and archive articles — this is what the public sees |
| `content.articles.delete` | write | ● | ● | · | destructive | Delete an unpublished article draft — refused once it has ever been published |
| `content.authors.read` | read | ● | ● | ● | — | View article authors |
| `content.authors.write` | write | ● | ● | ● | — | Create and edit article authors |
| `content.authors.delete` | write | ● | ● | · | destructive | Delete an article byline no article credits |

Support holds read and write and **not** publish or delete, so a Support administrator may fix a
typo in live prose but cannot decide what the public sees. The four names are granted one by one
rather than by family sweep: `allInFamily('content')` skips the two `destructive` deletes on its
own but **not** `publish`, which carries no flag (Phase 5 P-1).

### `files`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `files.resolve` | read | ● | ● | ● | — | Resolve file ids returned by this service into names, types and URLs |
| `files.content.read` | read | ● | ● | ● | **audited** | Open a file's contents, including delivery proofs and other private files |
| `files.orphans.read` | read | ● | ● | · | — | List uploaded files no record refers to |
| `files.library.read` | read | ● | ● | · | — | Browse every uploaded file on the platform, with its owner and what uses it |
| `files.upload` | write | ● | ● | · | — | Upload a file to the platform as the administration |
| `files.delete` | write | ● | · | · | destructive | Permanently delete a file from storage — unrecoverable |

**`files.content.read` is a separate name from `files.resolve`, and the reason is the whole
point of it.** Resolve is held by every tier because it discloses nothing the caller did not
already have — they hold an id that arrived on a record they were allowed to read, and turning
it into a name and a size adds nothing. **That reasoning stops at the metadata.** Opening the
file discloses a delivery-proof photograph (a place, a time, usually a residence) or a vendor's
saleable `digital/` product. Different acts get different names; the platform made the same call
for `money.payouts.destination.read`.

**Support holds it, and the audit row is the other half of that decision.** "The courier says
they delivered it and I never got it" is a Support ticket and the proof photo is its answer —
refusing them escalates every one to a tier that knows less about it. That is the same trade
already made for `agents.tracking.read`. What bounds it is not the grant but the record: **every
read commits an audit row before the bytes are fetched, and a failure of that write is not
caught**, so with the audit store unreachable nothing is disclosed.

⚠ **No `reason` is required**, unlike the two tracking disclosures — an operator opens many
images inside one dispute, and a per-image prompt becomes a box somebody types "dispute" into
forever. See [files.md](files.md#get-apiv1filesfileidcontent).

**`files.library.read` is the mount's rule in its third instance: a listing gets its own name.**
`files.resolve` is grantable to every tier on one argument — the caller already holds the id, so
resolving it discloses nothing new — and **that argument does not survive enumeration.** A caller
who can browse does not need to hold an id. `files.orphans.read` established the rule; the media
library follows it, and draws the same line at Support for the same reason.

⚠ **It is NOT audited, and the dashboard asked for the opposite.** Their case was good and is
recorded rather than waved away: this route discloses something the other four cannot, because it
enumerates. It was declined because ADR-006 D-5's exception test is *"the output IS the
disclosure"* — true of a payout destination, a live position, a trail and a file's bytes, and not
of a filename and a size — and because `files.orphans.read` already enumerates on this mount
unaudited. Auditing a *browse* surface also dilutes the trail it is meant to protect: an operator
paging a media picker would generate more rows in a minute than the four real disclosures do in a
week. **Adding it later is purely additive** — a catalogued action and one line on the route. See
[ADR-021](../ADR-021-ADMIN-MEDIA-LIBRARY.md) D-6.

**`files.upload` is the first write path for files on this service, and it IS audited** — because
it is a write, and every write here is. No exception argument was needed. The row matters more
than most: jovi-mall stamps the file `ownerId: <X-Actor-Id>`, an id in *this* service's database
that jovi-mall can never dereference, and it audits nothing on its own side because it
authenticates a **service** rather than a person. This row is the only record of who uploaded it.

⚠ **Support holds `content.articles.write` and not this**, so a Support administrator can fix a
typo in a live article and cannot add a picture to it. That asymmetry is deliberate and matches
the line every other `files.*` name draws; `test:files` § 5 pins it, because *"Support can already
edit the article"* is exactly the argument that would widen it without anyone revisiting the
enumeration question.

### `messaging`

Renamed from `broadcast` at Phase 5 Part C, along with its one permission. Nothing here
fans out: one message, one recipient, no audience and no delivery record.

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `messaging.telegram.send` | write | ● | ● | · | — | Send one Telegram message to one connected account |

A send cannot be recalled, so the audit row carries **the recipient and the full message
body** (Phase 5 O-2) — the only useful question about an un-undoable act is what was said
to whom. The body is operator-authored free text; the standard credential redaction and
size cap still apply to it.

### `users`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `users.read` | read | ● | ● | ● | — | Search users across every role and view their detail |
| `users.update` | write | ● | ● | · | — | Change a user’s login email or phone number |
| `users.suspend` | write | ● | ● | · | — | Suspend or reinstate a user account, blocking sign-in on every device |
| `users.sessions.revoke` † | write | ● | ● | · | — | Force a user to sign out of every device |
| `users.password.reset` | write | ● | ● | · | — | Send a user a password-reset link over email, WhatsApp or Telegram |
| `users.login_link.send` | write | ● | ● | · | — | Send a customer a passwordless sign-in link over email, WhatsApp or Telegram |
| `users.roles.manage` † | write | ● | · | · | destructive | Add or remove a user’s platform roles |

### `vendors`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `vendors.read` | read | ● | ● | ● | — | Search vendors and view their detail, store, catalogue and settings |
| `vendors.kyc.review` | write | ● | ● | · | — | Approve or reject a vendor’s business verification |
| `vendors.suspend` | write | ● | ● | · | — | Suspend or reinstate a vendor, taking their listings off sale |
| `vendors.products.manage` | write | ● | ● | · | — | Take a vendor’s product off sale, or put it back, as platform oversight |
| `vendors.settings.manage` | write | ● | ● | · | — | Change a vendor’s platform-governed order settings — not their commission |

> **The `customers` family is gone** (Phase 5 Part D, [ADR-017](../ADR-017-PHASE-17-CLOSEOUT.md)
> D-1). `customers.read` and `customers.suspend` were catalogued, **granted**, and backed no
> route — the only pair on the unbuilt list in that state, which is why they were deleted rather
> than left with a rationale: a granted permission with no endpoint appears in an
> administrator's effective set and promises a surface that does not exist.
>
> **No capability was lost.** The `users` family already covers customers role-agnostically:
> `GET /users?role=customer` is the directory, `GET /users/:userId` composes the `customer`
> role-profile, `POST /users/:userId/{suspend,restore}` is the suspension (audited
> `users.suspend` / `users.reinstate`), and order history is `orders.read?customerId=`.

### `shipments`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `shipments.read` | read | ● | ● | ● | — | Search shipments and view their detail and assignment state |
| `shipments.tracking.read` | read | ● | ● | ● | — | Read a delivery’s GPS trail and tracking events from geo-tracker — every trail read is recorded in the audit trail |
| `shipments.reassign` | write | ● | ● | · | — | Manually move a shipment to a different agent or agency |
| `shipments.cancel` | write | ● | ● | · | destructive | Cancel a shipment already in progress |

### `administrators`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `administrators.read` | read | ● | ● | · | — | View the administrator directory |
| `administrators.create` | write | ● | ● | · | — | Create an administrator account at a level below your own |
| `administrators.update` | write | ● | ● | · | — | Edit another administrator’s profile details |
| `administrators.suspend` | write | ● | ● | · | dual-control | Suspend or reinstate an administrator, ending all their sessions. Acting on a Developer requires a second Developer’s approval |
| `administrators.tier.set` | write | ● | · | · | escalation, dual-control | Change an administrator’s level. Promoting to Developer requires a second Developer’s approval |
| `administrators.sessions.read` | read | ● | ● | · | — | See another administrator’s active sessions |
| `administrators.sessions.revoke` | write | ● | ● | · | — | Sign another administrator out of every device |
| `administrators.password.reset` | write | ● | ● | · | — | Issue a new one-time password to another administrator, ending all their sessions |
| `administrators.mfa.reset` | write | ● | · | · | escalation | Clear another administrator’s two-factor enrolment so they can enrol again |

### `approvals`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `approvals.read` | read | ● | ● | · | — | View the queue of actions waiting for a second administrator’s approval |

### `permissions`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `permissions.read` | read | ● | ● | · | — | View which permissions each administrator level holds |

### `audit`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `audit.read` | read | ● | ● | ● | scoped:audit | Search the record of every administrator action |
| `audit.export` | read | ● | ● | · | destructive | Export the audit record for compliance, making exported rows eligible for retention purge |

### `notifications`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `notifications.read` | read | ● | ● | ● | — | Read the administrator inbox and platform alerts |
| `notifications.manage` † | write | ● | ● | · | — | Configure which events raise an administrator alert |

### `system`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `system.health.read` | read | ● | ● | · | — | View database, cache and downstream service health |
| `system.workers.read` | read | ● | ● | · | — | View background worker status and schedules |
| `system.outbox.read` | read | ● | ● | · | — | Inspect the outbound event queue and its depth |
| `system.metrics.read` | read | ● | ● | · | — | View the platform service's operational metrics, including per-route request volumes |
| `system.maintenance.read` | read | ● | ● | · | — | View whether the platform is in a maintenance window |
| `system.errors.read` | read | ● | ● | · | — | Investigate platform errors, including the internal message and unmasked details |

### `developer_tools`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `developer_tools.workers.trigger` | write | ● | · | · | destructive | Run a background worker immediately, against live data |
| `developer_tools.outbox.replay` | write | ● | · | · | destructive | Replay outbound events — downstream services will see them a second time |
| `developer_tools.webhooks.redeliver` † | write | ● | · | · | destructive | Redeliver a webhook to a downstream service |
| `developer_tools.catalogue.vectorise` | write | ● | · | · | destructive | Rebuild search vectors for the entire product catalogue |
| `developer_tools.feature_flags.read` | read | ● | · | · | — | View feature flag state |
| `developer_tools.feature_flags.set` | write | ● | · | · | destructive | Turn a feature flag on or off for the whole platform |
| `developer_tools.config.read` | read | ● | · | · | — | View non-secret runtime configuration |
| `developer_tools.maintenance.set` | write | ● | · | · | destructive | Put the platform into or out of a maintenance window, refusing writes or all traffic |
| `developer_tools.cache.flush` | write | ● | · | · | destructive | Delete cached keys from a named Redis database on the platform service |
| `developer_tools.logs.read` | read | ● | · | · | — | Search the platform service's logs, which are free text and can contain personal data |
| `developer_tools.database.inspect` | read | ● | · | · | — | Inspect the platform database's collections, sizes and index drift |
| `developer_tools.cache.inspect` | read | ● | · | · | — | List cache key names, types and TTLs in a named Redis database — never their values |
| `developer_tools.outbox.prune` | write | ● | · | · | destructive | Permanently delete delivered outbound events past a retention age |
---

## The four `†` permissions, and why each is unbuilt

Every other catalogued name is behind a live route. These four are not, and each has a reason
that is a **decision** rather than a backlog item — none of them has an implementation anywhere
to port, so building one is new work with an open design question in front of it.

| Permission | Why there is no endpoint | Record |
|---|---|---|
| `users.sessions.revoke` | jovi-mall issues **stateless JWTs with no session store**, so there is nothing to delete from. `users.suspend` covers the need it was catalogued for: a suspended user's next refresh is refused. Building this means giving jovi-mall a session store first | ADR-007 |
| `users.roles.manage` | Removing a role has **no defined semantics** — it strands the Store a vendor owns, and nothing decides what happens to the catalogue, the orders or the payouts behind it. The question is a domain design, not a route | ADR-007 |
| `notifications.manage` | Service-wide wording would block a tier-3 administrator configuring **their own** preferences, which they already may. Splitting the name is the prerequisite | ADR-013 D-9 |
| `developer_tools.webhooks.redeliver` | **Every webhook mount in the platform is inbound.** There is no outbound delivery record to replay — jovi-mall's dispatcher owns its own retry, and geo-tracker's `/webhooks/node` dedups on `eventId` | ADR-012 |

Two names left this list rather than staying on it, and the difference is worth knowing:
`users.password.reset` was **built** during Phase 17 once the login-link work supplied the
delivery channel ADR-007 said it was blocked on, and `customers.read` / `customers.suspend` were
**deleted** at Phase 5 Part D — see the note in the matrix above for why a granted-but-unrouted
name is not the same kind of thing as an ungranted one.

---

## Composite guards

**Fifteen** endpoints require **more than one** permission (`all` mode) because they compose
data from two or three domains. A caller missing any one of them is refused.

| Endpoint | Requires |
|---|---|
| `GET /users/:userId/activity` | `users.read` + `audit.read` |
| `GET /vendors/:vendorId/activity` | `vendors.read` + `audit.read` |
| `GET /vendors/:vendorId/agencies` | `vendors.read` + `agencies.read` |
| `GET /agencies/:agencyId/activity` | `agencies.read` + `audit.read` |
| `GET /agencies/:agencyId/agents` | `agencies.read` + `agents.read` |
| `GET /agents/:agentId/activity` | `agents.read` + `audit.read` |
| `GET /agents/:agentId/contracts` | `agents.read` + `agencies.read` |
| `GET /contracts/:contractId` | `agencies.read` + `agents.read` |
| `GET /orders/:orderId/activity` | `orders.read` + `audit.read` |
| `GET /shipments/:shipmentId/activity` | `shipments.read` + `audit.read` |
| `GET /shipments/:shipmentId/offers` | `shipments.read` + `agents.read` |
| `GET /cod/agents/:agentId/trust-events` | `cod.holders.read` + `agents.read` |
| `GET /money/payouts/:payoutId/activity` | `money.payouts.read` + `audit.read` |
| `GET /accounts/:ownerType/:ownerId` | `money.earnings.read` + `billing.plans.read` + `cod.overview.read` |
| `GET /accounts/:ownerType/:ownerId/activity` | `money.earnings.read` + `billing.plans.read` |

The `/accounts` surface is composed this way on purpose: an account view carries a subscriber
plan and a COD liability as well as earnings, so gating it on `money.earnings.read` alone would
be a side door onto billing and COD data. **No `accounts` permission family exists**, and none
should be added.

`GET /contracts/:contractId` is composite for the same reason, and it is the argument for
`/contracts` existing as its own mount at all: a contract's payload names a party from **each**
directory — an agent and an agency — so holding one directory's read permission is not enough
to see it. (This row was missing from the table until BR-012, and the count above read
"Thirteen". admin-dash's own `ROUTE-MAP.md` and `MIGRATION-2026-08.md` § 8 — authored in
`frontend/admin-dash/api-doc/`, not part of this tree — were both already right.)

### The one `any`-mode guard

`GET /system/errors` accepts **any** of `developer_tools.logs.read`, `system.errors.read`,
`support.errors.lookup` — and returns a *different projection* per level. See
[system.md](system.md).

**This one is not counted in the fifteen above**: fifteen `all`-mode guards plus this single
`any`-mode one, sixteen in all. `GET /vendors/:vendorId/agencies` is the fifteenth, added by
BR-018. ⚠ A page written before that says *fifteen* meaning "fourteen `all`-mode plus the
`any`-mode one" — the same claim about a set one endpoint smaller.

---

## Level-specific notes

### What Support (tier 3) deliberately does **not** hold

- The administrator directory — `administrators.*` is entirely withheld, which is why
  `audit.read` is scoped: without the scope the audit feed would be a side door onto it.
- Anything `financial` — enforced at boot, not by review.
- `audit.export`, because an export is the precondition for a retention purge and so carries
  `destructive`.
- Every write on users, vendors, agencies, agents, orders, shipments, COD, billing and money.

What Support **does** hold that surprises people: `money.payments.read` (gateway settlements).
"Did my payment go through, and was I refunded" is one of the commonest ticket questions, and
the sharp fields — raw gateway payload, payload hash, idempotency key — are removed by
**projection**, for everyone, rather than by permission.

### What Admin (tier 2) deliberately does **not** hold

`administrators.tier.set` (changing anyone's level is a Developer act), `administrators.mfa.reset`,
`files.delete`, `users.roles.manage`, and **all** of `developer_tools`.

### Developer (tier 1)

Holds everything. It is also the only level for which MFA enrolment is mandatory by default
(`ADMIN_MFA_REQUIRED_TIER`).

---

## Endpoints that expose this policy

| Endpoint | Access | Returns |
|---|---|---|
| `GET /api/v1/permissions/catalog` | any authenticated administrator | Every permission with its family, action, summary and flags |
| `GET /api/v1/permissions/me` | any authenticated administrator | The caller's own effective permission set — **build navigation from this** |
| `GET /api/v1/permissions/tiers` | `permissions.read` | The full level → permission matrix |

Full request/response detail in [authorization.md](authorization.md).

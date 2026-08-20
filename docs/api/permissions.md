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
| **1** | Developer | 113 of 113 | Everything, including the developer tools and every escalation-flagged action |
| **2** | Admin | 96 of 113 | The operational tier — runs the platform day to day, including the money |
| **3** | Support | 24 of 113 | Ticket work plus the read-only lookups needed to answer a ticket. Nothing financial, nothing destructive, no sight of the administrator directory |

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

---

## The matrix

● granted  ·  not granted  ·  **†** = catalogued policy with **no endpoint built yet**
(27 of 113 permissions; the policy is decided ahead of the surface, deliberately)

### `agents`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `agents.read` | read | ● | ● | ● | — | View delivery agents, their history, COD allocation, tracking policy and eligibility |
| `agents.status.set` | write | ● | ● | · | — | Activate or suspend an agent (a reason is required to suspend) |
| `agents.ban` | write | ● | ● | · | destructive | Permanently ban an agent from the platform |
| `agents.kyc.review` | write | ● | ● | · | — | Approve or reject an agent’s identity documents — this is what lets an agent work |
| `agents.tracking.set` | write | ● | ● | · | — | Override an agent’s live-location tracking permission |
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

### `content`  — *no endpoints yet*

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `content.articles.read` † | read | ● | ● | · | — | View and preview articles, published or not |
| `content.articles.write` † | write | ● | ● | · | — | Create and edit articles |
| `content.articles.publish` † | write | ● | ● | · | — | Publish, unpublish and archive articles — this is what the public sees |
| `content.articles.delete` † | write | ● | ● | · | destructive | Permanently delete an article |
| `content.authors.read` † | read | ● | ● | · | — | View article authors |
| `content.authors.write` † | write | ● | ● | · | — | Create and edit article authors |
| `content.authors.delete` † | write | ● | ● | · | destructive | Permanently delete an article author |

### `files`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `files.resolve` | read | ● | ● | ● | — | Resolve file ids returned by this service into names, types and URLs |
| `files.orphans.read` † | read | ● | ● | · | — | List uploaded files no record refers to |
| `files.delete` † | write | ● | · | · | destructive | Permanently delete a file from storage — unrecoverable |

### `broadcast`  — *no endpoints yet*

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `broadcast.send` † | write | ● | ● | · | — | Send a broadcast message to platform users |

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

### `customers`  — *no endpoints yet*

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `customers.read` † | read | ● | ● | ● | — | Search customers and view their detail and order history |
| `customers.suspend` † | write | ● | ● | · | — | Suspend or reinstate a customer |

### `shipments`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `shipments.read` | read | ● | ● | ● | — | Search shipments and view their detail and assignment state |
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

## Composite guards

Thirteen endpoints require **more than one** permission (`all` mode) because they compose data
from two or three domains. A caller missing any one of them is refused.

| Endpoint | Requires |
|---|---|
| `GET /users/:userId/activity` | `users.read` + `audit.read` |
| `GET /vendors/:vendorId/activity` | `vendors.read` + `audit.read` |
| `GET /agencies/:agencyId/activity` | `agencies.read` + `audit.read` |
| `GET /agencies/:agencyId/agents` | `agencies.read` + `agents.read` |
| `GET /agents/:agentId/activity` | `agents.read` + `audit.read` |
| `GET /agents/:agentId/contracts` | `agents.read` + `agencies.read` |
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

### The one `any`-mode guard

`GET /system/errors` accepts **any** of `developer_tools.logs.read`, `system.errors.read`,
`support.errors.lookup` — and returns a *different projection* per level. See
[system.md](system.md).

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

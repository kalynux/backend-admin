# `/audit` — the audit trail

**Verified against source on 2026-09-08** — all seven routes and their guards against the live route manifest; every query parameter, the 92-day span cap and the required export range against `audit/validators/audit.validator.ts`; the action, target-type, status and transport vocabularies re-derived by running the catalog (**114** actions and **23** target types, not 80 and 22 — `file` was missing) and `PERMISSION_FAMILIES` (**20**, not 21); the subject-class map against `audit/domain/audit-subject.ts:19-43`; and the retention default against `admin/src/config/env.ts:182`.

Base path: `/api/v1/audit`

Every administrator action, who did it, to what, and how it ended. Rows are **immutable** and
written in the same transaction as the change they describe wherever the change lands in this
service's own database.

Design records: [`../../docs/ADR-006-AUDIT.md`](../../docs/ADR-006-AUDIT.md),
[`../../docs/ADR-012-AUDIT-COMPLETION.md`](../../docs/ADR-012-AUDIT-COMPLETION.md).

| Method | Path | Permission | Audited |
|---|---|---|---|
| `GET` | `/audit` | `audit.read` | — |
| `GET` | `/audit/actions` | `audit.read` | — |
| `GET` | `/audit/:auditId` | `audit.read` | — |
| `POST` | `/audit/exports` | `audit.export` | ✅ |
| `GET` | `/audit/exports` | `audit.export` | — |
| `GET` | `/audit/exports/:exportId` | `audit.export` | — |
| `GET` | `/audit/exports/:exportId/download` | `audit.export` | — |

Two other endpoints serve the same collection, filtered to one administrator:
`GET /administrators/:adminId/activity` (what they **did**) and
`GET /administrators/:adminId/history` (what was done **to** them). Same query and response
shape as `GET /audit`. See [administrators.md](administrators.md).

`GET /administrators/me/activity` is the self-service variant and needs no permission at all —
an audit trail people cannot see their own entry in is one they have no way to challenge.

---

## Read scope — what Support sees

`audit.read` is held by **all three levels**, but what a Support administrator sees is narrowed
**per row**, in the query, not in the controller:

| Level | Sees |
|---|---|
| 1 Developer, 2 Admin | Every row |
| 3 Support | Rows whose subject is a **platform actor or record** (users, vendors, agencies, agents, customers, orders, shipments, remittances, deposits, discrepancies, payouts, tickets, articles, plans, **files**) — **plus anything they did themselves** |

Rows classed `internal` — administrators, admin sessions, approval requests, audit exports,
feature flags, workers, maintenance windows — are invisible to Support. Without that narrowing,
the audit feed would be a side door onto the administrator directory that the grant table
withholds from them.

**A row outside your scope answers `404`, not `403`.** A 403 would confirm the row exists,
which is an existence oracle over exactly the rows the scope hides.

---

## `GET /audit`

The feed.

| | |
|---|---|
| **Method / Path** | `GET /api/v1/audit` |
| **Permission** | `audit.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt` only. Default **`-occurredAt`** |

Only one sort key is offered, deliberately: an audit feed is a chronology, and sorting by actor
or action would invite full-collection scans on the largest collection in the database for an
ordering nobody reads a trail in. Filter by those instead.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `actorId` | 24-hex | The administrator who performed the action |
| `action` | enum | One of the catalogued action names — **175 on 2026-10-28** (114 on 2026-09-08), **and this number moves every phase**. Get the list from `GET /audit/actions` rather than hardcoding it; [the catalogue below](#the-action-catalogue) is for reading |
| `actionFamily` | enum | One of the **24** permission families (`PERMISSION_FAMILIES`; this said 20 until 2026-10-28) |
| `status` | enum | `attempted` \| `succeeded` \| `failed` \| `denied` \| `queued` |
| `targetType` | enum | See the target-type list below |
| `targetId` | string | 1–128 characters. **Not** validated as an ObjectId — a target may be a session UUID or a composite key |
| `correlationId` | string | 1–128 characters. The `requestId` of the originating request |
| `sensitiveOnly` | boolean flag | `true` → only money, escalation, destructive and four-eyes rows |
| `search` | string | 1–120 characters. Matches three text fields — see [What `search` matches](#what-search-matches) — and, for a whole 24-hex id, the row's target, related target or actor |
| `from` / `to` | ISO-8601 instant | Half-open `[from, to)`. **Maximum span 92 days** |
| `page` | integer | Default 1 |
| `limit` | integer | Default 20, max 100 |
| `sort` | string | `occurredAt` or `-occurredAt` |

`action`, `actionFamily`, `status` and `targetType` are **pinned enums**: a typo is a `400`
naming the valid values, rather than a filter that silently matches nothing.

#### What `search` matches

Case-insensitive, contains, over **three** fields:

| Field on the row | What it is |
|---|---|
| `actor.email` | the administrator's email at the time |
| `actor.displayName` | the administrator's name at the time |
| `target.label` | the human-readable name of what was acted on, when the action recorded one |

**It does not match the action name, the action family or the target type.** Typing
`users.suspend` or `order` into `search` returns an empty page. Those have their own filters
(`action`, `actionFamily`, `targetType`), which are pinned enums.

**A pasted id (since 2026-10-12, BR-028).** A term that is exactly 24 hexadecimal characters is
*also* matched as an id, against the row's `target.id`, `relatedTarget.id` and `actor.id`. So pasting a user id, an order id or an administrator id finds the rows about it
and, for an administrator, the rows they produced. Letter case does not matter. **An id matches
only whole**: a part of one is treated as text, and matches only if a label or an email happens
to contain it.

`targetId` and `actorId` remain the precise filters: `search` answers "anything to do with this
id", and they answer one question each. A target that is not a 24-hex id (a session UUID, a
composite key) is reachable through `targetId` only.

The read scope applies to a search exactly as it does to the feed. A Support administrator who
pastes an administrator's id gets only the rows they could already read.

Pinned by `npm run test:audit` § 8b.

#### `targetType` values

`user`, `vendor`, `agency`, `agent`, `customer`, `order`, `shipment`, `remittance`, `deposit`,
`discrepancy`, `payout`, `ticket`, `article`, `plan`, `category`, `review`, `booking`, `refund`,
`file`, `administrator`, `admin_session`, `approval_request`, `audit_export`, `feature_flag`,
`worker`, `maintenance_window`, `payment_settings`, `none`

**28 values** (re-measured against `AUDIT_TARGET_TYPES` 2026-10-28, when `refund` was added here:
the refund flow's request actions target it. On 2026-10-05 this list said 23 and was missing
`category`, `payment_settings` and the two added that day, `review` and `booking`). An unrecognised value stored in a row falls back to `none`, which classifies as
`internal` — so an unclassifiable row is withheld from Support rather than leaked to them.

### Example request

```
GET /api/v1/audit?actionFamily=money&sensitiveOnly=true
    &from=2026-08-01T00:00:00.000Z&to=2026-08-13T00:00:00.000Z
    &sort=-occurredAt&limit=50
```

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66bc4f0a1d2e3f4a5b6c7d8e",
      "occurredAt": "2026-08-12T14:22:09.117Z",
      "completedAt": "2026-08-12T14:22:09.884Z",
      "correlationId": "8f14c2a0-6b3e-4a91-9c7d-2e5f0a1b3c4d",

      "action": "money.payouts.mark_paid",
      "actionSummary": "Mark a payout request as paid — records that money has left the platform",
      "actionFamily": "money",
      "status": "succeeded",
      "sensitive": true,

      "actor": {
        "kind": "administrator",
        "id": "665f1c2a9b3e4a91c7d2e5f0",
        "email": "ada@wimall.cm",
        "displayName": "Ada Nkemelu",
        "tier": 2,
        "sessionId": "0f9c8b7a-6d5e-4c3b-2a19-8f7e6d5c4b3a"
      },

      "target": {
        "type": "payout",
        "id": "66a1b2c3d4e5f60718293a4b",
        "label": "PR-2026-004182",
        "subjectClass": "platform_record"
      },

      "relatedTarget": { "type": "agency", "id": "665c0011223344556677889a" },

      "request": {
        "method": "POST",
        "path": "/api/v1/money/payouts/66a1b2c3d4e5f60718293a4b/mark-paid",
        "ip": "102.244.18.7",
        "userAgent": "Mozilla/5.0 …"
      },

      "outcome": {
        "code": null,
        "statusCode": 200,
        "message": null,
        "denialKind": null,
        "requiredPermissions": [],
        "platformCode": null
      },

      "viaApprovalId": "66a0f31c8b2d4e5f60718293",
      "delegated": true,

      "exportedAt": null,
      "purgeAfter": null
    }
  ],
  "meta": {
    "total": 4127,
    "page": 1,
    "limit": 50,
    "pages": 83,
    "retentionDays": 365,
    "oldestRetainedAt": "2025-08-14T09:00:00.000Z"
  }
}
```

#### Extra `meta` fields

| Field | Notes |
|---|---|
| `retentionDays` | The configured retention window |
| `oldestRetainedAt` | The oldest row still in the collection, or `null`. **Render this** — it is why the feed stops where it does, rather than the feed looking broken at the boundary |

#### Entry fields

| Field | Type | Notes |
|---|---|---|
| `occurredAt` | ISO-8601 | When the intent was recorded |
| `completedAt` | ISO-8601 \| null | When the outcome landed. Null on an `attempted` row that never resolved |
| `correlationId` | string | The originating request's id. **Join on this to follow one action across rows** |
| `action` | string | The catalogued action name |
| `actionSummary` | string \| null | The catalog's one-line description, so a feed reads without a lookup table. `null` for a row whose action is no longer catalogued |
| `actionFamily` | string | |
| `status` | enum | `attempted` (intent recorded, outcome unknown) · `succeeded` · `failed` · `denied` (an authorization refusal) · `queued` (sent for four-eyes approval) |
| `sensitive` | boolean | Money, escalation, destructive or four-eyes |
| `actor.kind` | `administrator` \| `system` \| `anonymous` | `system` = the approval-expiry sweep, the purge, the bootstrap CLI. `anonymous` = a login attempt against an address matching no account |
| `actor.tier` | number \| null | **The level held at the time**, not the level now |
| `target.subjectClass` | `platform_actor` \| `platform_record` \| `internal` | The read-scoping axis |
| `relatedTarget` | object \| null | A second record the action also concerned |
| `outcome.denialKind` | string \| null | Present on `denied` rows |
| `outcome.requiredPermissions` | string[] | `[]` when not a denial |
| `outcome.platformCode` | string \| null | jovi-mall's own error code, on a failed delegated write |
| `viaApprovalId` | string \| null | Set when the action was committed through four eyes |
| `delegated` | boolean | Whether the change was executed by jovi-mall rather than written here |
| `exportedAt` | ISO-8601 \| null | |
| `purgeAfter` | ISO-8601 \| null | When the row becomes eligible for deletion. **Null until it has been exported** — retention is exported-AND-aged, not aged alone |

`payload`, `before` and `after` are **not** on list rows. Fetch the entry detail for those.

---

## `GET /audit/actions`

The action vocabulary, so a dashboard builds its filter from the catalog instead of discovering
it by collecting 400s.

| | |
|---|---|
| **Permission** | `audit.read` |
| **Parameters** | None |
| **Pagination** | None |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "actions": [
      {
        "name": "money.payouts.mark_paid",
        "family": "money",
        "target": "payout",
        "transport": "delegated",
        "permission": "money.payouts.mark_paid",
        "summary": "Mark a payout request as paid — records that money has left the platform"
      }
    ],
    "total": 175
  }
}
```

| Field | Notes |
|---|---|
| `target` | The `targetType` rows for this action carry |
| `transport` | Where the change lands, which decides how it can be audited: `wi_admin_txn` (row and change commit in one transaction — an unaudited action is impossible) · `delegated` (jovi-mall over HTTP; intent → outcome) · `external` (Redis or the platform connection; intent → outcome) · `observation` (nothing to roll back — a login happened; best-effort) |
| `permission` | The permission that governs the action |

---

## The action catalogue

**Re-derived 2026-10-28 (BR-032 § 3, BR-033 § 5) by running `AUDIT_CATALOG` from
`audit/domain/audit.catalog.ts`: 175 actions in 22 families.** Until that date this page named no
action list at all, only a count (*"114"*, eight months stale). Every action added since, from
refunds, categories, damage claims, delivery pauses and bookings, therefore appeared nowhere here.
`GET /audit/actions` is still the source to build a filter from. This table is for reading, and
it will drift again, so prefer the endpoint.

Families are the action name's first segment, which is what `GET /audit/actions` reports.
**Permission** `—` means no permission governs the action (a login, a system sweep). Two families
in the permission catalogue record no action of their own (`permissions`, `system`), which is why
22 appear here against 24 permission families.


### `administrators` (26)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `administrators.create` | `administrator` | wi_admin_txn | `administrators.create` | Created an administrator account |
| `administrators.update` | `administrator` | wi_admin_txn | `administrators.update` | Edited another administrator's profile |
| `administrators.profile.update_self` | `administrator` | wi_admin_txn | — | Edited their own profile |
| `administrators.suspend` | `administrator` | wi_admin_txn | `administrators.suspend` | Suspended an administrator |
| `administrators.reinstate` | `administrator` | wi_admin_txn | `administrators.suspend` | Reinstated a suspended administrator |
| `administrators.tier.set` | `administrator` | wi_admin_txn | `administrators.tier.set` | Changed an administrator's level |
| `administrators.mfa.reset` | `administrator` | wi_admin_txn | `administrators.mfa.reset` | Cleared another administrator’s two-factor enrolment |
| `administrators.password.reset` | `administrator` | wi_admin_txn | `administrators.password.reset` | Reset another administrator's password |
| `administrators.activate` | `administrator` | wi_admin_txn | `administrators.activate` | Activated a pending administrator |
| `administrators.sessions.revoke` | `administrator` | external | `administrators.sessions.revoke` | Signed an administrator out of every device |
| `administrators.sessions.revoke_one` | `admin_session` | external | `administrators.sessions.revoke` | Ended one of an administrator's sessions |
| `administrators.auth.login_succeeded` | `administrator` | observation | — | Signed in |
| `administrators.auth.login_failed` | `administrator` | observation | — | A sign-in attempt failed |
| `administrators.auth.lockout_engaged` | `administrator` | observation | — | An account was locked after repeated failures |
| `administrators.auth.mfa_failed` | `administrator` | observation | — | A two-factor code was rejected |
| `administrators.auth.refresh_reuse_detected` | `administrator` | observation | — | A superseded refresh token was replayed — the session was destroyed |
| `administrators.auth.mfa_enrolled` | `administrator` | wi_admin_txn | — | Started two-factor enrolment |
| `administrators.auth.mfa_activated` | `administrator` | wi_admin_txn | — | Activated two-factor authentication |
| `administrators.auth.password_changed` | `administrator` | wi_admin_txn | — | Changed their own password |
| `administrators.profile.phone_set` | `administrator` | wi_admin_txn | — | Set their own contact phone number |
| `administrators.profile.phone_verified` | `administrator` | wi_admin_txn | — | Verified their own contact phone number |
| `administrators.auth.logout` | `administrator` | external | — | Signed out |
| `administrators.auth.logout_all` | `administrator` | external | — | Signed out of every device |
| `administrators.auth.session_revoked` | `admin_session` | external | — | Ended one of their own sessions |
| `administrators.auth.mfa_challenged` | `administrator` | observation | — | Password accepted — a two-factor code was requested |
| `administrators.auth.session_terminated` | `administrator` | observation | — | Their sessions were ended because the account is suspended |

### `employees` (6)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `employees.record.update_self` | `administrator` | wi_admin_txn | — | Updated their own employee record |
| `employees.documents.upload` | `administrator` | external | — | Uploaded an identity document to their own employee record |
| `employees.documents.attach` | `administrator` | wi_admin_txn | — | Filed an identity document into a slot on their own record |
| `employees.documents.detach` | `administrator` | wi_admin_txn | — | Removed an identity document from their own record |
| `employees.avatar.set` | `administrator` | wi_admin_txn | — | Changed their own profile picture |
| `employees.employment.update` | `administrator` | wi_admin_txn | `employees.employment.write` | Set an administrator's position, contract terms or salary |

### `approvals` (4)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `approvals.approved` | `approval_request` | wi_admin_txn | `approvals.read` | Approved another administrator’s request |
| `approvals.rejected` | `approval_request` | wi_admin_txn | `approvals.read` | Rejected another administrator’s request |
| `approvals.withdrawn` | `approval_request` | wi_admin_txn | — | Withdrew their own request |
| `approvals.expired` | `approval_request` | wi_admin_txn | — | A request expired undecided |

### `cod` (8)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `cod.remittances.confirm` | `remittance` | delegated | `cod.remittances.confirm` | Confirmed an agency cash remittance |
| `cod.remittances.reject` | `remittance` | delegated | `cod.remittances.reject` | Rejected an agency remittance declaration |
| `cod.deposits.confirm` | `deposit` | delegated | `cod.deposits.confirm` | Confirmed an agent cash deposit |
| `cod.deposits.create` | `deposit` | delegated | `cod.deposits.create` | Recorded cash paid directly to the platform by an agent |
| `cod.deposits.reject` | `deposit` | delegated | `cod.deposits.reject` | Rejected a recorded cash deposit |
| `cod.discrepancies.resolve` | `discrepancy` | delegated | `cod.discrepancies.resolve` | Resolved a cash discrepancy, deciding who absorbs the shortfall |
| `cod.trust.adjust` | `agent` | delegated | `cod.trust.adjust` | Manually adjusted an agent's cash trust score |
| `cod.triage` | `agency` | delegated | `cod.triage` | Endorsed a declared COD deposit or remittance as genuine — a review note, not a confirmation |

### `agents` (12)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `agents.status.set` | `agent` | delegated | `agents.status.set` | Changed an agent’s account status |
| `agents.kyc.review` | `agent` | delegated | `agents.kyc.review` | Reviewed an agent’s identity documents — this is what lets an agent work |
| `agents.tracking.set` | `agent` | delegated | `agents.tracking.set` | Changed whether an agent may be tracked |
| `agents.cod_threshold.set` | `agent` | delegated | `agents.cod_threshold.set` | Pinned how much cash on delivery an agent may hold, overriding the 500 000 default |
| `agents.cod_threshold.release` | `agent` | delegated | `agents.cod_threshold.set` | Released an agent’s COD pool pin — back to the 500 000 default |
| `agents.ban` | `agent` | delegated | `agents.ban` | Banned an agent from the platform |
| `agents.unban` | `agent` | delegated | `agents.ban` | Lifted an agent’s platform ban |
| `agents.tracking.position.read` | `agent` | external | `agents.tracking.read` | Read an agent’s live position from geo-tracker |
| `agents.transfer` | `agent` | delegated | `agents.transfer` | Moved an agent from one delivery agency to another |
| `agents.contracts.suspend` | `agent` | delegated | `agents.contracts.manage` | Froze one agent↔agency contract — no new assignments, terms untouched |
| `agents.contracts.reinstate` | `agent` | delegated | `agents.contracts.manage` | Unfroze one agent↔agency contract |
| `agents.contracts.terminate` | `agent` | delegated | `agents.contracts.manage` | Asked to end one agent↔agency contract (completes only once the balances are clear) |

### `shipments` (5)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `shipments.tracking.trail.read` | `shipment` | external | `shipments.tracking.read` | Read a delivery’s GPS trail from geo-tracker |
| `shipments.reassign` | `shipment` | delegated | `shipments.reassign` | Moved a shipment to a different delivery agent |
| `shipments.agent.assign` | `shipment` | delegated | `shipments.reassign` | Offered an unassigned shipment to a named delivery agent |
| `shipments.agency.move` | `shipment` | delegated | `shipments.reassign` | Moved a shipment to a different delivery agency |
| `shipments.cancel` | `shipment` | delegated | `shipments.cancel` | Cancelled a shipment and put its items back for re-routing |

### `support` (13)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `support.tickets.create` | `ticket` | delegated | `support.tickets.create` | Opened a support ticket on somebody’s behalf |
| `support.tickets.update` | `ticket` | delegated | `support.tickets.update` | Edited a ticket’s subject or description |
| `support.tickets.status.set` | `ticket` | delegated | `support.tickets.update` | Moved a ticket to a new status |
| `support.tickets.priority.set` | `ticket` | delegated | `support.tickets.update` | Changed a ticket’s priority — which locks it to administrators thereafter |
| `support.tickets.assign` | `ticket` | delegated | `support.tickets.assign` | Handed a ticket to another administrator |
| `support.tickets.claim` | `ticket` | delegated | `support.tickets.assign` | Claimed an unassigned ticket from the pool |
| `support.tickets.close` | `ticket` | delegated | `support.tickets.lifecycle` | Closed a ticket |
| `support.tickets.reopen` | `ticket` | delegated | `support.tickets.lifecycle` | Reopened a closed ticket |
| `support.tickets.followers.add` | `ticket` | delegated | `support.tickets.followers.manage` | Added a follower to a ticket |
| `support.tickets.followers.remove` | `ticket` | delegated | `support.tickets.followers.manage` | Removed a follower from a ticket |
| `support.tickets.notes.create` | `ticket` | delegated | `support.tickets.notes.write` | Added a note to a ticket |
| `support.tickets.attachments.attach` | `ticket` | delegated | `support.tickets.attachments.write` | Attached an uploaded file to a ticket |
| `support.tickets.attachments.delete` | `ticket` | delegated | `support.tickets.attachments.write` | Deleted a ticket attachment |

### `content` (9)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `content.articles.create` | `article` | external | `content.articles.write` | Created an article draft |
| `content.articles.update` | `article` | external | `content.articles.write` | Edited an article |
| `content.articles.publish` | `article` | external | `content.articles.publish` | Published an article — this is what the public sees |
| `content.articles.unpublish` | `article` | external | `content.articles.publish` | Pulled a published article back to draft |
| `content.articles.archive` | `article` | external | `content.articles.publish` | Retired an article — its URL now answers 410 with its category |
| `content.articles.delete` | `article` | external | `content.articles.delete` | Deleted an unpublished article draft |
| `content.authors.create` | `article` | external | `content.authors.write` | Created an article byline |
| `content.authors.update` | `article` | external | `content.authors.write` | Edited an article byline |
| `content.authors.delete` | `article` | external | `content.authors.delete` | Deleted an unused article byline |

### `files` (3)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `files.delete` | `file` | delegated | `files.delete` | Permanently deleted an uploaded file — unrecoverable |
| `files.content.read` | `file` | delegated | `files.content.read` | Opened an uploaded file’s contents |
| `files.upload` | `file` | delegated | `files.upload` | Uploaded a file to the platform as the administration |

### `messaging` (1)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `messaging.telegram.send` | `user` | external | `messaging.telegram.send` | Sent a Telegram message to a connected account |

### `agencies` (9)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `agencies.verify` | `agency` | delegated | `agencies.verify` | Approved a delivery agency’s business verification |
| `agencies.reject` | `agency` | delegated | `agencies.verify` | Refused a delivery agency’s business verification |
| `agencies.deactivate` | `agency` | delegated | `agencies.deactivate` | Deactivated a delivery agency and suspended every product defaulting to it |
| `agencies.reactivate` | `agency` | delegated | `agencies.reactivate` | Reactivated a delivery agency and put its dependent products back on sale |
| `agencies.cod_limit.set` | `agency` | delegated | `agencies.cod_limit.set` | Pinned how much cash on delivery an agency may hold, overriding the default |
| `agencies.cod_limit.release` | `agency` | delegated | `agencies.cod_limit.set` | Released an agency’s COD limit pin — back to the 1 000 000 default |
| `agencies.cod.restrict` | `agency` | delegated | `agencies.cod.restrict` | Switched cash on delivery off for a delivery agency |
| `agencies.cod.unrestrict` | `agency` | delegated | `agencies.cod.restrict` | Switched cash on delivery back on for a delivery agency |
| `agencies.claims.charge` | `agency` | delegated | `agencies.claims.charge` | Charged a damage claim to a delivery agency for a parcel damaged in delivery |

### `users` (10)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `users.update` | `user` | delegated | `users.update` | Changed a user’s login email or phone number |
| `users.suspend` | `user` | delegated | `users.suspend` | Suspended a user account |
| `users.reinstate` | `user` | delegated | `users.suspend` | Lifted a user account suspension |
| `users.password_reset_link.send` | `user` | delegated | `users.password.reset` | Sent a user a password-reset link |
| `users.login_link.send` | `user` | delegated | `users.login_link.send` | Sent a customer a passwordless sign-in link |
| `users.bot_memory.reset` | `user` | delegated | `users.bot_memory.reset` | Reset the customer bot’s conversation memory for a user |
| `users.close.request` | `user` | delegated | `users.close` | Asked a user to close one of their roles |
| `users.close.cancel` | `user` | delegated | `users.close` | Withdrew a request asking a user to close one of their roles |
| `users.cod.restrict` | `user` | delegated | `users.cod.restrict` | Switched cash on delivery off for a customer |
| `users.cod.unrestrict` | `user` | delegated | `users.cod.restrict` | Switched cash on delivery back on for a customer |

### `vendors` (7)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `vendors.suspend` | `vendor` | delegated | `vendors.suspend` | Suspended a vendor and took their listings off sale |
| `vendors.reinstate` | `vendor` | delegated | `vendors.suspend` | Lifted a vendor suspension and put their listings back on sale |
| `vendors.kyc.approve` | `vendor` | delegated | `vendors.kyc.review` | Approved a vendor’s business verification |
| `vendors.kyc.reject` | `vendor` | delegated | `vendors.kyc.review` | Rejected a vendor’s business verification |
| `vendors.products.suspend` | `vendor` | delegated | `vendors.products.manage` | Took one of a vendor’s products off sale as platform oversight |
| `vendors.products.restore` | `vendor` | delegated | `vendors.products.manage` | Put one of a vendor’s suspended products back on sale |
| `vendors.settings.update` | `vendor` | delegated | `vendors.settings.manage` | Changed a vendor’s platform-governed order settings |

### `bookings` (7)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `bookings.cancel` | `booking` | delegated | `bookings.settle` | Cancelled a booking for a party — the customer is refunded, the fault decides who bears the fees |
| `bookings.cancel_session` | `booking` | delegated | `bookings.settle` | Cancelled every booking of one class (same service, same start) — each customer refunded |
| `bookings.complete` | `booking` | delegated | `bookings.settle` | Completed a booking for the vendor — the vendor is paid once the hold ends |
| `bookings.payment.mark_cash` | `booking` | delegated | `bookings.settle` | Recorded that a booking was paid in cash to the vendor |
| `bookings.payment.recheck` | `booking` | delegated | `bookings.intervene` | Re-checked a stuck booking payment with the payment provider |
| `bookings.proposal.withdraw` | `booking` | delegated | `bookings.intervene` | Withdrew a proposal of a new time on a booking — the original time stands |
| `bookings.reminder.resend` | `booking` | delegated | `bookings.remind` | Sent the customer their appointment reminder again |

### `catalog` (3)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `catalog.categories.rename` | `category` | delegated | `catalog.categories.manage` | Renamed a shared product category (the old spelling stays as an alias) |
| `catalog.categories.merge` | `category` | delegated | `catalog.categories.manage` | Merged one product category into another, moving every product that held it |
| `catalog.categories.delete` | `category` | delegated | `catalog.categories.manage` | Deleted an unused product category |

### `reviews` (3)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `reviews.unpublish` | `review` | delegated | `reviews.moderate` | Hid a published review (its star left the rating) |
| `reviews.republish` | `review` | delegated | `reviews.moderate` | Put a hidden review back on public view |
| `reviews.delete` | `review` | delegated | `reviews.delete` | Deleted a review for good — its author may write a new one |

### `orders` (13)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `orders.disputes.resolve` | `order` | delegated | `orders.disputes.resolve` | Resolved an order payment dispute, deciding who keeps the money |
| `orders.cancel` | `order` | delegated | `orders.intervene` | Cancelled an order |
| `orders.dispatch` | `order` | delegated | `orders.intervene` | Dispatched a stalled order to its delivery agency |
| `orders.refund` | `order` | delegated | `orders.refund` | Refunded an order, in full or in part |
| `orders.delivery_fee_refund.settle` | `order` | delegated | `orders.refund` | Settled a delivery-fee refund owed to a customer — recorded the money as returned by hand, or as covered by a refund of the whole order |
| `orders.refund.request` | `refund` | delegated | `orders.refund.request` | Raised a refund request for approval — the seller’s earnings are held until it is decided |
| `orders.refund.approve` | `refund` | delegated | `orders.refund` | Approved a refund request — the platform sends the money (or waits for COD cash to reach it) |
| `orders.refund.reject` | `refund` | delegated | `orders.refund` | Rejected a refund request — the seller’s earnings are released from the refund hold |
| `orders.refund.partial_return_fault` | `refund` | delegated | `orders.refund` | Said whose fault a partly paid order’s returned parcel is — the waiting refund is replaced with the matching amount |
| `orders.refund.retry` | `refund` | delegated | `orders.refund` | Retried a failed refund transfer — the same transfer reference is reused |
| `orders.refund.resolve_unknown` | `refund` | delegated | `orders.refund` | Decided a refund transfer whose outcome was unknown — arrived, or failed |
| `orders.refund.settle_external` | `refund` | delegated | `orders.refund.settle_external` | Recorded a refund as paid outside the platform, with a picture proof |
| `orders.refund.proof.upload` | `file` | delegated | `orders.refund.request` | Uploaded a refund proof picture (the customer’s message giving a number, or a receipt) |
| `orders.refund.proof.read` | `file` | external | `orders.refund.read` | Opened a refund proof picture |

### `billing` (6)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `billing.plans.create` | `plan` | delegated | `billing.plans.manage` | Created a pricing plan |
| `billing.plans.update` | `plan` | delegated | `billing.plans.manage` | Edited a pricing plan |
| `billing.plans.delete` | `plan` | delegated | `billing.plans.delete` | Archived a pricing plan |
| `billing.subscriptions.assign_vendor` | `vendor` | delegated | `billing.subscriptions.assign` | Assigned a subscription plan to a vendor |
| `billing.subscriptions.assign_agency` | `agency` | delegated | `billing.subscriptions.assign` | Assigned a subscription plan to an agency |
| `billing.subscriptions.assign_agent` | `agent` | delegated | `billing.subscriptions.assign` | Assigned a subscription plan to a delivery agent |

### `money` (18)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `money.payouts.mark_paid` | `payout` | delegated | `money.payouts.mark_paid` | Marked a payout request paid — money has left the platform |
| `money.payouts.triage` | `payout` | delegated | `money.payouts.triage` | Endorsed a payout request as genuine — a review note, not a payment |
| `money.payouts.reject` | `payout` | delegated | `money.payouts.reject` | Rejected a payout request and returned the funds to the available balance |
| `money.payouts.resolve_unknown_paid` | `payout` | delegated | `money.payouts.mark_paid` | Confirmed a payout whose transfer outcome was unknown as PAID — money has left the platform |
| `money.payouts.resolve_unknown_failed` | `payout` | delegated | `money.payouts.triage` | Recorded a payout whose transfer outcome was unknown as FAILED — the funds stay held |
| `money.payouts.destination.read` | `payout` | external | `money.payouts.destination.read` | Revealed the full payout destination on a payout request |
| `money.earnings.pause_order` | `order` | delegated | `money.earnings.pause` | Paused the earnings of an order — none of its money will be paid out until resumed |
| `money.earnings.resume_order` | `order` | delegated | `money.earnings.pause` | Resumed the earnings of an order — its hold continues where it stopped |
| `money.earnings.pause_booking` | `booking` | delegated | `money.earnings.pause` | Paused the earnings of a booking — none of its money will be paid out until resumed |
| `money.earnings.resume_booking` | `booking` | delegated | `money.earnings.pause` | Resumed the earnings of a booking — its hold continues where it stopped |
| `money.earnings.pause_shipment` | `shipment` | delegated | `money.earnings.pause` | Paused a delivery's earnings — its agency and rider are not paid until resumed |
| `money.earnings.resume_shipment` | `shipment` | delegated | `money.earnings.pause` | Resumed a delivery's earnings — its agency's and rider's hold continues where it stopped |
| `money.earnings.clawback.write_off_vendor` | `vendor` | delegated | `money.earnings.clawback.write_off` | Wrote off refund debt a vendor owed the platform — the platform absorbs the loss |
| `money.earnings.clawback.write_off_agency` | `agency` | delegated | `money.earnings.clawback.write_off` | Wrote off refund debt an agency owed the platform — the platform absorbs the loss |
| `money.earnings.clawback.write_off_agent` | `agent` | delegated | `money.earnings.clawback.write_off` | Wrote off refund debt a delivery agent owed the platform — the platform absorbs the loss |
| `money.statements.send_vendor` | `vendor` | external | `money.statements.send` | Generated a vendor's account statement (downloaded or emailed to them) |
| `money.statements.send_agency` | `agency` | external | `money.statements.send` | Generated an agency's account statement (downloaded or emailed to them) |
| `money.statements.send_agent` | `agent` | external | `money.statements.send` | Generated an agent's account statement (downloaded or emailed to them) |

### `developer_tools` (8)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `developer_tools.feature_flags.set` | `feature_flag` | wi_admin_txn | `developer_tools.feature_flags.set` | Turned a feature flag on or off |
| `developer_tools.workers.trigger` | `worker` | delegated | `developer_tools.workers.trigger` | Ran a background worker immediately, against live data |
| `developer_tools.outbox.replay` | `none` | delegated | `developer_tools.outbox.replay` | Replayed failed outbound events — downstream services see them again |
| `developer_tools.catalogue.vectorise` | `none` | delegated | `developer_tools.catalogue.vectorise` | Rebuilt search vectors across the product catalogue |
| `developer_tools.maintenance.set` | `maintenance_window` | delegated | `developer_tools.maintenance.set` | Changed the platform maintenance mode |
| `developer_tools.cache.flush` | `none` | delegated | `developer_tools.cache.flush` | Deleted cached keys from a platform Redis database |
| `developer_tools.outbox.prune` | `none` | delegated | `developer_tools.outbox.prune` | Deleted delivered tracking-outbox rows past a retention age |
| `developer_tools.payments.set` | `payment_settings` | delegated | `developer_tools.payments.set` | Changed payment routing — the collection or payout aggregator, Stripe, or the offered providers |

### `audit` (3)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `audit.export` | `audit_export` | external | `audit.export` | Exported the audit record |
| `audit.purge` | `audit_export` | external | — | Deleted exported audit rows past their retention period |
| `audit.retention.restamp` | `audit_export` | external | `audit.export` | Recomputed when exported audit rows become deletable |

### `notifications` (1)

| Action | Target | Transport | Permission | Summary |
|---|---|---|---|---|
| `notifications.preferences.update_self` | `administrator` | wi_admin_txn | — | Changed their own notification preferences |

---

## `GET /audit/:auditId`

One entry, with the state the list omits.

| | |
|---|---|
| **Permission** | `audit.read` |
| **Path parameter** | `auditId` — 24-hex |

### Response (200)

Every field of a list entry, **plus**:

| Field | Type | Notes |
|---|---|---|
| `payload` | object \| null | The request payload, with credential-shaped fields redacted by name |
| `before` | object \| null | The changed fields as they were |
| `after` | object \| null | The changed fields as they became |
| `stateTruncated` | boolean | True when a value was too large to store and was replaced by a summary |

```jsonc
{
  "success": true,
  "data": {
    "id": "66bc4f0a1d2e3f4a5b6c7d8e",
    "…": "…all list fields…",
    "payload": { "tier": 2 },
    "before":  { "tier": 3 },
    "after":   { "tier": 2 },
    "stateTruncated": false
  }
}
```

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed id |
| 404 | `AUDIT_ENTRY_NOT_FOUND` | No such row — **or the row is outside your read scope** |

---

# Exports

An export writes an **NDJSON** file and marks the rows it covers as exported. **It does not
purge.** Deletion from a dashboard would be one misclick from irreversible; purging lives in the
CLI (`npm run audit:export -- --purge`).

Retention is **exported-AND-aged**: a row's `purgeAfter` stays `null` until an export has
stamped it, so nothing can age out of the trail without first having been written to a file.

---

## `POST /audit/exports`

| | |
|---|---|
| **Permission** | `audit.export` — Developer and Admin. Flagged `destructive`, because an export is the precondition for deletion |
| **Status** | `201` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `from` | ISO-8601 instant | **Required** |
| `to` | ISO-8601 instant | **Required.** Must be after `from` |

Both are required here, unlike the feed's. An export with no range means "the whole
collection", and the API path is bounded by row count — asking for it here is almost always a
mistake. The CLI takes an open range.

```json
{ "from": "2026-07-01T00:00:00.000Z", "to": "2026-08-01T00:00:00.000Z" }
```

### Response (201)

```jsonc
{
  "success": true,
  "data": {
    "id": "66bd1122334455667788990a",
    "status": "complete",
    "source": "api",
    "requestedBy": "665f1c2a9b3e4a91c7d2e5f0",
    "requestedByName": "Ada Nkemelu",
    "rangeFrom": "2026-07-01T00:00:00.000Z",
    "rangeTo": "2026-08-01T00:00:00.000Z",
    "fileName": "audit-2026-07-01_2026-08-01-66bd1122.ndjson",
    "byteSize": 8412330,
    "rowCount": 12043,
    "sha256": "9f2b8c1a…",
    "retentionDays": 365,
    "startedAt": "2026-08-13T09:20:00.000Z",
    "completedAt": "2026-08-13T09:20:07.442Z",
    "stampedAt": "2026-08-13T09:20:07.501Z",
    "stampedCount": 12043,
    "purgedAt": null,
    "purgedCount": null,
    "failureReason": null,
    "downloadable": true
  },
  "message": "Exported 12043 row(s). Nothing was deleted — use the CLI with --purge for that."
}
```

| Field | Notes |
|---|---|
| `source` | `"api"` here; `"cli"` for CLI-produced exports |
| `sha256` | Checksum of the file, so a client can verify what it downloaded |
| `stampedAt` / `stampedCount` | When the covered rows were marked exported, and how many |
| `purgedAt` / `purgedCount` | Always `null` for an API export |
| `downloadable` | True once the file is durable |
| **`fileName`, never a path** | A server filesystem path is nothing a dashboard can use and something an attacker can |

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing `from` or `to` ("An export needs both `from` and `to`. Use the CLI for an open-ended export."), or `to` not after `from` |
| 422 | `AUDIT_EXPORT_TOO_LARGE` | The range covers more than `ADMIN_AUDIT_EXPORT_API_MAX_ROWS` (default **50 000**). `details` carries the row count and points at the CLI. Narrow the range |

### Audit

`audit.export`

---

## `GET /audit/exports`

| | |
|---|---|
| **Permission** | `audit.export` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `startedAt` only. Default **`-startedAt`** |
| **Filters** | None |

### Response (200)

A paginated array of the export objects shown above, with the standard
`{ total, page, limit, pages }` meta.

---

## `GET /audit/exports/:exportId`

| | |
|---|---|
| **Permission** | `audit.export` |
| **Path parameter** | `exportId` — 24-hex |
| **Response** | A single export object |
| **Errors** | `400 VALIDATION_ERROR`, `404 AUDIT_EXPORT_NOT_FOUND` |

---

## `GET /audit/exports/:exportId/download`

Stream the file.

**The one endpoint in this service that does not answer with the JSON envelope**, because the
payload is a file.

| | |
|---|---|
| **Permission** | `audit.export` |
| **Response** | The NDJSON file body |

### Response headers

| Header | Value |
|---|---|
| `Content-Type` | `application/x-ndjson` |
| `Content-Disposition` | `attachment; filename="audit-….ndjson"` |
| `X-Content-SHA256` | The manifest's checksum, when recorded — verify the download against it |

### Errors

These **do** use the JSON envelope.

| Status | Code | When |
|---|---|---|
| 404 | `AUDIT_EXPORT_NOT_FOUND` | No such export |
| 409 | `AUDIT_EXPORT_INCOMPLETE` | The export did not finish, so its file is not durable |
| 410 | `AUDIT_EXPORT_FILE_MISSING` | The record exists; the file is gone. `details.fileName` names it |

> **Deployment caveat.** The file lives on the instance that wrote it. Behind a load balancer
> with more than one instance this returns `410` unless `ADMIN_AUDIT_EXPORT_DIR` points at
> shared storage.

---

# `GET /audit/legacy` — **DELETED at Phase 5 Part D**

This route served the interim feed of administrative actions still performed **on jovi-mall**
rather than through this service: a second router on the `/audit` prefix, reading
`admin_action_log` in the platform database with a vocabulary of its own.

It was built to be deleted, and the deletion was **enforced rather than remembered**.
`test-authz.ts` carried a tripwire reading *"the legacy-audit module is deleted once the legacy
surface is"* — the moment Phase 5 Part C ported the last legacy endpoint and
`LEGACY_ENDPOINT_COUNT` reached 0, the suite went red and stayed red until the module was gone.

## What a client should do

Nothing calls this any more, and nothing should. It answers **404** like any unknown path — the
`AUDIT_LEGACY_FEED_DISABLED` code that used to mean *"the feed is switched off by its flag"* is
deleted too, along with the flag.

The dashboard's log screen reads `GET /audit`, which is the compliance record and always was.
The legacy feed was never that: every page it returned carried `"legacy": true` and
`"retiresAtCutover": true` precisely so a dashboard could not render it as the audit trail by
omission.

## Where the history went — nowhere

**The rows are still in Mongo.** `admin_action_log` survives cutover and is still written:
`AuditLogger` routes any entry whose actor role is `admin` into it, and `AdminAgencyService`
reaches it over `/api/internal/admin/agencies`. What was deleted is *this service's read* of it.

The reason is that after cutover the collection stops being a distinct record. Every new row in
it duplicates a wi-admin audit row for the same operation, written with a real administrator
identity, the same correlation id and a catalogued action — so the feed would report the same
events twice in two vocabularies, one of them worse. If the historical rows are ever needed,
they are reachable through the developer tools.

Design records: [ADR-017](../../docs/ADR-017-PHASE-17-CLOSEOUT.md) D-8 (the deletion) and
[Phase 5 § C-10](../../../PRODUCTION-READINESS/PHASE-5-LEGACY-CLOSEOUT-PLAN.md) (why the
collection itself must not be deleted with it).

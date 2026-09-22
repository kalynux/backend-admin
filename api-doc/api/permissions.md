# Permissions and administrator levels

⚠ **Re-measured against source 2026-09-22: 124 permissions across 21 families, tier totals 124 / 104 / 38.** This closes the gap the previous note flagged. ADR-024's `cod.triage` and `money.payouts.triage` now have rows, and four tier-3 grants that this document showed as withheld — `cod.overview.read`, `cod.remittances.read`, `cod.deposits.read`, `money.payouts.read` — are marked as granted, which is what the code has always said. **The matrix below now equals `npm run authz:matrix`**; the totals in the level table count it, so the two agree with the code rather than merely with each other.

⚠ **Two consequences of that correction are not arithmetic, and a client mirroring this file must pick them up.** *"Support holds nothing financial"* is **no longer true without qualification** — `money.payouts.triage` is `financial` and tier 3 holds it under a named exemption — and the `any`-mode guard count moved from three to **four**, because `POST /money/payouts/:payoutId/reject` accepts `money.payouts.reject` **or** `money.payouts.triage`. Both are detailed below. Re-derive rather than quoting.

⚠ **Re-measured 2026-09-14 (ADR-023): 121 permissions across 21 families, tier totals 121 / 101 / 31.** The new family is `employees` (2 permissions) and the new name in `administrators` is `administrators.activate`; all three are **tier 1 only**, so tiers 2 and 3 are unchanged. Re-derive rather than quoting — `npm run authz:matrix`.

**Verified against source on 2026-09-08** — the 118 permissions then existing, the 20 families, all three tier totals (118 / 101 / 31), the four unrouted `†` names and both composite-guard counts (17 `all`-mode, 3 `any`-mode), each re-derived by *executing* `admin/src/modules/authorization/domain/permission.catalog.ts`, `tier-grants.ts` and the live route manifest at HEAD rather than by reading them.

This is the complete authorization policy. It is **static code**, not data: there are no
per-administrator overrides, no policy collections, and nothing is editable at runtime.
Changing what a level can do means shipping a release.

Design records: [`../../docs/ADR-003-GRANULAR-PERMISSIONS.md`](../../docs/ADR-003-GRANULAR-PERMISSIONS.md),
[`../../docs/ADR-001-DATA-ACCESS-MODEL.md`](../../docs/ADR-001-DATA-ACCESS-MODEL.md).

---

## The three levels

**Lower number = more privilege.** This trips people up; it is worth saying twice.

| Level (`tier`) | Label | Holds | Shape of the job |
|---|---|---|---|
| **1** | Developer | 124 of 124 | Everything, including the developer tools and every escalation-flagged action |
| **2** | Admin | 104 of 124 | The operational tier — runs the platform day to day, including the money |
| **3** | Support | 38 of 124 | Ticket work, the lookups needed to answer a ticket, editorial write on articles and bylines, resetting the customer bot's memory of a chat, and **pre-screening** a declared COD handover or a payout request. Nothing destructive, publishing stays a level above, and the one `financial` permission it holds cannot send money anywhere |

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
| `financial` | Moves money, changes a record money is computed from, **or discloses a payment destination** | **Refused to Support (tier 3) at boot**, except the one name on a typed allowlist |
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

**`money.payouts.triage` is the second edge case, and it is the only `financial` permission any
Support administrator holds** (ADR-024). It is flagged honestly rather than conveniently: one of
its two verdicts moves money between columns, because a payout request holds the owner's whole
balance in `requested_balance` from the moment it opens and **rejecting releases that hold** back
to `available_balance`. Endorsing touches nothing. Rather than mis-flag it to make the grant table
accept it, the grant table takes a **named exemption** — `TIER_3_FINANCIAL_ALLOWLIST` in
`tier-grants.ts`, a one-element array, so admitting a second name is a deliberate two-file change.
The line it draws: **Support may release a hold back to the owner it belongs to, and may never
send money out of the platform.** `money.payouts.mark_paid` is a separate permission tier 3 does
not hold, and no combination of triage verdicts causes money to leave.

⚠ **Its COD sibling `cod.triage` is deliberately NOT flagged, and the asymmetry is real.** A COD
deposit or remittance sitting in `declared` holds **nothing** — only a *confirmed* one moves cash —
so neither endorsing nor rejecting one is a money movement. It therefore needs no exemption and
takes none, and being unflagged means `allInFamily('cod')` expands it to Admin without anyone
typing it in by hand. It does **not** grant confirming: `cod.deposits.confirm` and
`cod.remittances.confirm` stay `financial` and stay out of Support's reach.

### Four reads are audited, and three of them are held by Support

"Reads are not actions" is the rule, and it holds because a read leaves no state behind — so the
permission gate is the whole control and a row per read would be volume with nothing to say.
**Four permissions break it**, all for the same reason: their *output* **is** the disclosure.

| Permission | Route | What it discloses | Held by Support |
|---|---|---|:-:|
| `money.payouts.destination.read` | `GET /money/payouts/:payoutId/destination` | A beneficiary's account number | no (`financial`) |
| `agents.tracking.read` | `GET /agents/:agentId/live-position` | Where a person is, right now | **yes** |
| `shipments.tracking.read` | `GET /shipments/:shipmentId/tracking-trail` | Where a person went, over one delivery | **yes** |
| `files.content.read` | `GET /files/:fileId/content` | The bytes of a private file — a delivery-proof photograph, a vendor's saleable digital product | **yes** |

⚠ **The permission is audited on the disclosing route only, not everywhere it is accepted.**
`agents.tracking.read` also opens `GET /agents/:agentId/tracking-presence` and
`shipments.tracking.read` also opens `GET /shipments/:shipmentId/tracking-events`; neither emits
a coordinate, and neither writes a row. Four permissions, four audited routes — see the § on
`files` below for why `files.library.read` is *not* the fifth.

For a disclosure, "who *may*" is not the interesting question; **"who *did*, and how often"** is.
An administrator who unmasks forty positions in an afternoon is doing something other than
answering tickets, and nothing else in this service would ever see it.

The two tracking permissions are **unflagged** and reach Support deliberately — *"where is my
delivery right now"* is what a ticket asks, and refusing it to the tier that answers tickets
escalates every one of them. **The audit is the other half of that decision**: on every
coordinate-emitting read the row commits **before** the disclosure and its failure is not caught,
so with the audit store unreachable nothing is disclosed. Widening the audience and adding the
record were one decision, not two. See [ADR-020](../../docs/ADR-020-ADMIN-DATA-DOOR.md) D-5.

---

## The matrix

● granted  ·  not granted  ·  **†** = catalogued policy with **no endpoint built yet**
(**4** of 124 permissions — down from 27, and the four that remain each have a written reason
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
| `agents.cod_threshold.set` | write | ● | ● | · | financial | Pin (or release) how much cash on delivery an agent may hold, overriding their plan |
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
| `cod.overview.read` | read | ● | ● | ● | — | View the cash-on-delivery position across the platform |
| `cod.remittances.read` | read | ● | ● | ● | — | View cash remittances declared by agencies |
| `cod.remittances.confirm` | write | ● | ● | · | financial | Confirm a cash remittance — settles collections FIFO and unlocks the agency’s earnings |
| `cod.remittances.reject` | write | ● | ● | · | financial | Reject a declared cash remittance |
| `cod.deposits.read` | read | ● | ● | ● | — | View cash deposits paid directly to the platform |
| `cod.deposits.create` | write | ● | ● | · | financial | Record cash received directly from an agent or agency |
| `cod.deposits.confirm` | write | ● | ● | · | financial | Confirm a recorded cash deposit |
| `cod.deposits.reject` | write | ● | ● | · | financial | Reject a recorded cash deposit |
| `cod.discrepancies.read` | read | ● | ● | · | — | View cash discrepancies raised against agents and agencies |
| `cod.discrepancies.resolve` | write | ● | ● | · | financial | Resolve a cash discrepancy, deciding who absorbs the shortfall |
| `cod.holders.read` | read | ● | ● | · | — | View which agents and agencies are currently holding platform cash |
| `cod.trust.adjust` | write | ● | ● | · | financial | Manually adjust an agent’s cash trust score, changing how much they may carry |
| `cod.triage` | write | ● | ● | ● | — | Endorse a declared COD deposit or remittance as genuine — never confirms cash |

**Support reaches four names here, and every one that moves cash is still Admin and above**
(ADR-024). The three reads plus `cod.triage`; the seven `financial` writes — including
`cod.deposits.create`, the one route that asserts money arrived — are unchanged. The line is
narrower than "nothing here is Support's" and it is still a line: **a reviewer may say a declared
handover looks genuine; only an Admin may say the cash arrived.**

⛔ **Endorsement gates nothing.** An un-endorsed remittance is exactly as confirmable as an
endorsed one, so do not disable a confirm control on a missing `triage`. And the triage surface is
smaller than the table suggests: `POST /cod/deposits/:depositId/triage` reaches
**platform-recipient deposits only**, because jovi-mall refuses an administrator on an
agency-recipient deposit — that handover is counter-signed by the agency itself and the platform
never saw the cash. Remittances are all administrator-confirmed, so triage applies to every one.
Full contract in [cod.md](cod.md).

### `money`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `money.earnings.read` | read | ● | ● | · | — | View platform earnings and the earnings ledger |
| `money.payouts.read` | read | ● | ● | ● | — | View the payout request queue |
| `money.payouts.mark_paid` | write | ● | ● | · | financial, dual-control | Mark a payout request as paid — records that money has left the platform |
| `money.payouts.reject` | write | ● | ● | · | financial | Reject a payout request |
| `money.payouts.triage` | write | ● | ● | ● | financial | Endorse a payout request as genuine, or reject it — never sends money |
| `money.payouts.destination.read` | read | ● | ● | · | financial | Reveal the full payout destination (account or mobile number) on one payout request — every reveal is recorded in the audit trail |
| `money.payments.read` | read | ● | ● | ● | — | View gateway payment and refund settlements |

**Payout review is two stages and only one of them moves money** (ADR-024). `money.payouts.triage`
opens `POST /money/payouts/:payoutId/triage`, the pre-screen: a reviewer endorses the request as
genuine, which moves no money, changes no status and gates nothing. It is the only permission on
this surface a Support administrator can **write** with, and — with `money.payouts.read` beside it
— one of only three they hold here.

⚠ **The rejection is not a second triage verdict; it is the same terminal write anyone else
makes.** `POST /money/payouts/:payoutId/reject` accepts **either** `money.payouts.reject` **or**
`money.payouts.triage`, so a reviewer and an approver reach one code path and close the record one
way. That release is what makes the triage permission `financial` — see the § on the flags above,
and the fourth `any`-mode row under Composite guards below.

⛔ **Endorsement is advisory. A payout nobody has endorsed is exactly as payable as one that has
been** — do not disable an approve control on a missing `triage`, because an empty Support queue
must never stall payments. Sending stays `money.payouts.mark_paid`, which tier 3 does not hold and
cannot reach. Full contract in [money.md](money.md).

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
| `support.automation.lookup` | read | ● | ● | ● | — | See whether the customer bot was degraded on a channel, and when — the narrowest of the three views of the automation failure feed |
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
| `files.content.read` | read | ● | ● | ● | **audited** | Open a file’s contents, including delivery proofs and other private files — every read is recorded in the audit trail |
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
[ADR-021](../../docs/ADR-021-ADMIN-MEDIA-LIBRARY.md) D-6.

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
| `users.bot_memory.reset` | write | ● | ● | ● | — | Reset the customer bot’s conversation memory for one user, so their next chat starts fresh |
| `users.roles.manage` † | write | ● | · | · | destructive | Add or remove a user’s platform roles |

`users.bot_memory.reset` is the one `users` write Support holds, by the owner's decision
(2026-09-22). It deletes no order, message record or account data, only what the bot remembers
of the chat. So the ticket that reports a confused bot can be closed at the level that received
it. It carries no flag: `destructive` would make the boot check refuse it to Support.

### `vendors`

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `vendors.read` | read | ● | ● | ● | — | Search vendors and view their detail, store, catalogue and settings |
| `vendors.kyc.review` | write | ● | ● | · | — | Approve or reject a vendor’s business verification |
| `vendors.suspend` | write | ● | ● | · | — | Suspend or reinstate a vendor, taking their listings off sale |
| `vendors.products.manage` | write | ● | ● | · | — | Take a vendor’s product off sale, or put it back, as platform oversight |
| `vendors.settings.manage` | write | ● | ● | · | — | Change a vendor’s platform-governed order settings — not their commission |

> **The `customers` family is gone** (Phase 5 Part D, [ADR-017](../../docs/ADR-017-PHASE-17-CLOSEOUT.md)
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
| `administrators.activate` | write | ● | · | · | escalation | Activate a pending administrator once their employee record is complete |

⚠ **`administrators.activate` is tier 1 not because activation is a senior act, but because it
requires reading the employee record** — and only tier 1 may. An Admin able to activate would be
admitting a person whose file they cannot open. The consequence is deliberate: a tier-2 Admin can
CREATE a Support account and cannot turn it on.

### `employees`

**Added 2026-09-14 (ADR-023). The narrowest family on this service: tier 1 and the subject, and
nobody else at any tier.**

⚠ **Its existence as a separate family IS the access control.** Tier 2 holds
`allInFamily('administrators')`, so a permission for the staff record living *there* would be a
permission an Admin holds — and a colleague's salary, date of birth and home address is not
something an Admin may read. Neither name carries an `escalation` or `financial`-only guard that
would keep it out of a family sweep on its own (`employees.read` is an ordinary read, and
flagging it otherwise would misdescribe it here), so a **boot assertion** refuses the family to
any tier but 1.

⚠ **Neither of these is how the SUBJECT reads their own record.** That is `selfService` —
`/employees/me` — because every administrator maintains their own by definition. These two are
for reading and writing somebody *else's*.

| Permission | Action | 1 Dev | 2 Admin | 3 Support | Flags | Summary |
|---|---|:-:|:-:|:-:|---|---|
| `employees.read` | read | ● | · | · | — | Read another administrator’s employee record — identity, contacts, address and salary |
| `employees.employment.write` | write | ● | · | · | financial | Set another administrator’s position, contract terms and monthly salary |

⚠ **`employees.read` does not disclose the DOCUMENTS.** The record returns file ids; the bytes
need `files.content.read`, which is audited per file and fail-closed. The two are separate
exposures and are separately recorded.

⚠ **`employees.employment.write` is narrower than its name.** It cannot touch the personal,
identity, address, contact or payout halves — those have no administrative write path at all. An
employee states their own facts; the company states its terms.

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
| `system.automation.read` | read | ● | ● | · | — | Investigate automation-layer failures — which workflow, which node, what it reported |

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

**Seventeen** endpoints require **more than one** permission (`all` mode) because they compose
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
| `GET /agents/:agentId/cod-allocation` | `agents.read` + `agencies.read` |
| `GET /agents/:agentId/assignability` | `agents.read` + `agencies.read` |
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

### The four `any`-mode guards

Four endpoints accept **any** of several permissions. **They are not all the same shape**, and the
difference decides what a client should do with them.

**Three are graded reads.** They return a *different projection* per level: the permission does not
decide whether you get an answer, it decides how much of the answer you see.

| Endpoint | Accepts any of | Contract |
|---|---|---|
| `GET /system/errors` | `developer_tools.logs.read`, `system.errors.read`, `support.errors.lookup` | [system.md](system.md) |
| `GET /automation/failures` | `developer_tools.logs.read`, `system.automation.read`, `support.automation.lookup` | [automation.md](automation.md) |
| `GET /automation/summary` | `developer_tools.logs.read`, `system.automation.read`, `support.automation.lookup` | [automation.md](automation.md) |

**The fourth is a write, and it is not graded at all** — both holders perform exactly the same
thing, with the same body and the same result.

| Endpoint | Accepts any of | Contract |
|---|---|---|
| `POST /money/payouts/:payoutId/reject` | `money.payouts.reject`, `money.payouts.triage` | [money.md](money.md) |

⚠ **Do not model that one as a graded read.** A reviewer's rejection is *terminal* — it closes the
request and releases the hold back to the owner's available balance — and there is deliberately no
second "reject" verdict on `/triage`, because two routes writing the same terminal state is how a
record ends up closed two different ways. This is also the route that makes `money.payouts.triage`
`financial`: without it accepting that name, the flag and its tier-3 exemption would be describing
a capability the permission did not have.

**These four are not counted in the seventeen above**: seventeen `all`-mode guards plus four
`any`-mode ones, **twenty-one** composite guards in all.

⚠ **This count has been stale four separate times, so derive it rather than quoting it.** It
read *"Thirteen"* until BR-012 added `GET /contracts/:contractId`; *"fourteen `all`-mode plus the
`any`-mode one"* until BR-018 added `GET /vendors/:vendorId/agencies`; *"fifteen … sixteen in
all"* until a re-count found that `GET /agents/:agentId/cod-allocation` and
`GET /agents/:agentId/assignability` had never been listed and that the automation pair had landed
since; and *"three `any`-mode … twenty in all"* until 2026-09-22, when ADR-024's
`POST /money/payouts/:payoutId/reject` turned out to have been an `anyPermission` site all along.
Every composite guard is a `permission(a, b)` or `anyPermission(a, b, c)` argument at a
`defineRoute` call site, so the live route manifest can be counted instead of read:

```bash
grep -rn "anyPermission(" src/modules/*/routes/*.ts          # the any-mode guards
grep -rn "access: permission([^)]*,[^)]*)" src/modules/*/routes/*.ts   # the all-mode ones
```

---

## Level-specific notes

### What Support (tier 3) deliberately does **not** hold

- The administrator directory — `administrators.*` is entirely withheld, which is why
  `audit.read` is scoped: without the scope the audit feed would be a side door onto it.
- Anything `financial` — enforced at boot, not by review — **with exactly one exemption**,
  `money.payouts.triage`, which is named in a one-element allowlist rather than waved through
  by a weakened rule. Every other `financial` name is refused to tier 3 at boot as before.
- `audit.export`, because an export is the precondition for a retention purge and so carries
  `destructive`.
- Anything `destructive`, without exception — there is no allowlist for that flag.
- Every write on users, vendors, agencies, agents, orders, shipments, billing and money,
  with three exceptions: `users.bot_memory.reset`, which touches no platform record;
  `cod.triage`; and `money.payouts.triage`. The last two are **pre-screens** — they endorse a
  declaration as genuine. Neither confirms cash and neither sends money.

What Support **does** hold that surprises people, and the reason is the same each time — the
question arrives as a ticket, so refusing it to the tier that answers tickets escalates every one:

- `money.payments.read` (gateway settlements). *"Did my payment go through, and was I refunded"*
  is one of the commonest ticket questions, and the sharp fields — raw gateway payload, payload
  hash, idempotency key — are removed by **projection**, for everyone, rather than by permission.
- The three COD reads and `money.payouts.read`, so a reviewer can see the queue and the cash
  position they are being asked to pre-screen against.
- `cod.triage` and `money.payouts.triage` — the pre-screens themselves, and the latter is the
  only `financial` permission this tier holds anywhere.
- `agents.tracking.read`, `shipments.tracking.read` and `files.content.read`, all three of which
  are **audited per disclosure and fail closed**. See the § on audited reads above.

### What Admin (tier 2) deliberately does **not** hold

`administrators.tier.set` (changing anyone's level is a Developer act), `administrators.mfa.reset`,
`administrators.activate`, `files.delete`, `users.roles.manage`, **all** of `developer_tools` — and,
since ADR-023, **all** of `employees`. An Admin can manage the administrator directory and cannot
open a colleague's employment record.

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

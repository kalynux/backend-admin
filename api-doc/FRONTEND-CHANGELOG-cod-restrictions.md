# Admin dashboard — switching cash on delivery off for one customer or one agency

> **Date:** 2026-10-10 · **Audience:** the admin dashboard · **Breaking:** ⚠ **nothing on the
> wire.** Six new routes, two new permissions, four new audit actions, and three additive
> read fields. No existing request or response changes shape. The permission-vocabulary and
> route-map suites move when the doc mirror is re-copied (§ 7).
>
> **Not deployed yet.** It ships with jovi-mall, which owns the data and the enforcement.
> wi-admin only exposes the routes, gates them, audits them and delegates.
>
> The contract pages: [`api/users.md`](./api/users.md#the-customers-cod-restriction) ·
> [`api/agencies.md`](./api/agencies.md#the-agencys-cod-restriction) ·
> [`api/permissions.md`](./api/permissions.md)

| # | Change | Kind |
|---|---|---|
| 1 | **Customer switch** on a customer's page: *Restrict cash on delivery* / *Lift restriction* — `GET` · `PUT /users/:userId/cod-restriction`, `POST …/cod-restriction/lift` | additive |
| 2 | **Agency switch** on an agency's page, same three routes under `/agencies/:agencyId` | additive |
| 3 | New permission **`users.cod.restrict`** — Developer and Admin. **Not Support** | additive |
| 4 | New permission **`agencies.cod.restrict`** (`financial`) — Developer and Admin. **Not Support** | additive |
| 5 | Four audit actions: `users.cod.restrict`, `users.cod.unrestrict`, `agencies.cod.restrict`, `agencies.cod.unrestrict` | additive |
| 6 | `codRestriction` on the agency detail and on the **customer** entry of a user's `profiles`; `codRestricted` / `codRestrictedAt` on the agency COD-limit read | additive |
| 7 | ⚠ The permission vocabulary moves **140 → 142** (tiers **142 / 120 / 47**) and the route map gains six rows | **chore** |

---

## 1 · What this is, in plain language

Until now cash on delivery was governed only by rules: the seller's terms, the agency's own
settings, amount limits. **An administrator can now switch it off for one customer or one
delivery agency, by hand, and switch it back on.** Nothing does it automatically, and an
account nobody touched behaves exactly as it did yesterday.

### The customer switch

It is the lever the Returns policy already promises — refusing parcels without a valid reason
"may lead us to restrict cash on delivery on your account".

**While it is on, the customer cannot *place* a cash-on-delivery order.** Checkout refuses it
and the pay screen stops offering it, on the website and in the bot.

It does **not**:

- touch an order already placed, a parcel already on its way, or the cash owed on it;
- touch any other payment method — the customer can still pay online for anything;
- suspend the account, sign anybody out, or change what else the customer can do.

### The agency switch

**While it is on, the agency receives no *new* cash-on-delivery work.**

- A vendor **cannot send a COD shipment to it**. Auto-dispatch holds the shipment back, and a
  manual dispatch or a change of agency is refused. ⚠ **A vendor's `force` does not get past
  it** — `force` waives amount limits, and this is not an amount.
- A **customer simply stops seeing cash on delivery** for a basket this agency would carry. To
  them it looks exactly like an agency that never offered it.

It does **not**:

- touch parcels the agency already holds — they run to the end;
- touch the cash chain. A restricted agency **still owes, and can still hand over,** the cash
  it holds: collections, deposits and remittances are unchanged;
- touch prepaid orders — it still carries those;
- rewrite the agency's own COD setting (`policies.cod.enabled`) or its cash limit. Lifting the
  restriction returns it to exactly what it had configured.

### ⚠ The restricted party is never shown the reason

The `reason` you type is **the administrator's**. jovi-mall never shows it to the customer or to
the agency, and the dashboard must not either (do not paste it into a message to them).

What each side is told instead, so support copy can match it:

| Who | What they see |
|---|---|
| The customer | Cash on delivery is not offered. A COD checkout attempted anyway is refused with *"Cash on delivery is not available on this account — choose another payment method"* — no reason, no detail |
| The agency | That it is restricted, and since when: jovi-mall's COD-limit read for the agency carries `codRestricted` and `codRestrictedAt`. Not why, not by whom |
| A vendor dispatching to a restricted agency | *"This delivery agency cannot take cash-on-delivery shipments at the moment — choose another agency"*. Not why |

**Nobody is notified when a restriction is set or lifted.** jovi-mall sends no message to the
customer or the agency for either act. If they should be told, that is a conversation Support
has with them.

---

## 2 · The six routes

Both mounts are the same shape and answer the **same body**.

| Method | Path | Permission | Audit action |
|---|---|---|---|
| `GET` | `/api/v1/users/:userId/cod-restriction` | `users.read` | — |
| `PUT` | `/api/v1/users/:userId/cod-restriction` | `users.cod.restrict` | `users.cod.restrict` |
| `POST` | `/api/v1/users/:userId/cod-restriction/lift` | `users.cod.restrict` | `users.cod.unrestrict` |
| `GET` | `/api/v1/agencies/:agencyId/cod-restriction` | `agencies.read` | — |
| `PUT` | `/api/v1/agencies/:agencyId/cod-restriction` | `agencies.cod.restrict` | `agencies.cod.restrict` |
| `POST` | `/api/v1/agencies/:agencyId/cod-restriction/lift` | `agencies.cod.restrict` | `agencies.cod.unrestrict` |

### The response — all six

```jsonc
{
  "success": true,
  "data": {
    "subject": "customer",                       // "customer" on /users, "agency" on /agencies
    "subjectId": "665f1c2a9b3e4a91c7d2e5f1",     // the customer PROFILE id, or the agency id
    "userId": "665f1c2a9b3e4a91c7d2e5f0",        // the owning account; may be null on an agency
    "restricted": true,
    "restriction": {                             // null when not restricted
      "reason": "Refused three parcels without a reason",
      "restrictedAt": "2026-10-10T09:30:00.000Z",
      "restrictedByUserId": "66b0…",             // a wi-admin ADMINISTRATOR id, not a platform user
      "restrictedBySource": "admin",
      "restrictedByName": "Ada Admin"
    }
  },
  "message": "Cash on delivery restricted for this customer"   // on the two writes only
}
```

Exactly these fields — wi-admin names them one by one. After a successful `/lift`, `restricted`
is `false` and `restriction` is `null`.

⚠ On the **customer** mount `subjectId` is **not** the `:userId` you called with: it is the id
of the customer profile (the same value as the customer entry's `id` in `profiles`). `userId`
is the account. On the agency mount `subjectId` is the `:agencyId`.

### The two write bodies — identical on both mounts

```http
PUT /api/v1/users/:userId/cod-restriction
Content-Type: application/json

{ "reason": "Refused three parcels without a reason" }
```

```http
POST /api/v1/agencies/:agencyId/cod-restriction/lift
Content-Type: application/json

{ "reason": "Shortfalls settled; reviewed with the agency" }
```

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required — to restrict AND to lift.** Trimmed, 3–500 characters |

- The body is **strict**: any key other than `reason` is a `400 VALIDATION_ERROR`.
- ⚠ **There is no `restricted` field.** The direction is the route: `PUT` restricts, `POST
  …/lift` lifts. Do not send a boolean.
- ⚠ **Lifting needs a reason too.** This is unlike *Restore* on a user and *Reactivate* on an
  agency, which take none. Lifting erases the stored restriction, so the reason you give for
  lifting is kept only in the audit trail — the dialog must not let it be skipped.
- Cookie-authenticated calls send the CSRF header, as on every other write.

### Errors

| Status | Code | What the screen should do |
|---|---|---|
| `400` | `VALIDATION_ERROR` | A malformed id, a `reason` missing or outside 3–500 characters, or an unknown key. Field-level, as everywhere |
| `403` | `AUTHZ_PERMISSION_DENIED` | The caller lacks the write permission — every Support administrator does. If you see it, the button's gate and `/permissions/me` disagree |
| `404` | `NOT_FOUND` | No such user / agency. Checked by wi-admin before jovi-mall is called |
| `404` | `PLATFORM_OPERATION_REJECTED`, `details.platformCode: "AUTH_PROFILE_NOT_FOUND"` | ⚠ **Customer mount only — see § 4.** The account exists and has **no customer profile**, so there is nothing to restrict. The read answers it too |
| `409` | `PLATFORM_OPERATION_REJECTED`, `details.platformCode: "COD_RESTRICTION_UNCHANGED"` | ⚠ **See below.** It is already in the state you asked for |
| `500` | `INTERNAL_SERVER_ERROR` | The audit trail could not record the attempt. **Nothing changed** — jovi-mall is not called until the audit row exists |
| `502` / `503` | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall failed or is unreachable. A write is never retried automatically, so it *may* have happened. **Re-read (`GET`) before offering the button again** |

#### `409 COD_RESTRICTION_UNCHANGED`

The write is a compare-and-set. Restricting an account that is already restricted, or lifting
one that is not, is refused rather than silently accepted — otherwise two administrators with
the same page open would each believe their reason was the one on record.

You will meet it when the page is stale: a colleague pressed the button first, or it was
double-submitted. **Do not treat it as a failure to retry.** Re-fetch the restriction, show
what is actually there (including the *other* administrator's reason), and say so: *"Cash on
delivery was already restricted by Ada Admin."*

After a `502` / `503`, a retry that answers this `409` means the first attempt **did** land.

---

## 3 · The permissions

| Permission | Guards | Developer | Admin | Support | Flag |
|---|---|:-:|:-:|:-:|---|
| `users.cod.restrict` | `PUT` and `POST …/lift` on `/users/:userId/cod-restriction` | ● | ● | · | — |
| `agencies.cod.restrict` | `PUT` and `POST …/lift` on `/agencies/:agencyId/cod-restriction` | ● | ● | · | `financial` |

One permission covers **both directions** on each mount. Neither is dual-controlled — there is
no approval queue and no `202`.

The two **reads** need only `users.read` and `agencies.read`, which Support holds. So a Support
administrator **sees** that a restriction exists, its reason and who set it — that is the
conversation they will be having — and cannot change it.

**Gate each button on its permission from `GET /permissions/me`, never on tier.** `can('users.cod.restrict')`
and `can('agencies.cod.restrict')`. The grant is what the service decides today; the gate is
the contract. A tier check in the dashboard would be wrong the day a grant moves, and nothing
would tell you.

---

## 4 · Where it goes on screen

### `UserDetail`

1. **Show the switch only when `record.roles.includes('customer')`.** The restriction lives on
   the customer profile; an account without the customer role answers
   `404 PLATFORM_OPERATION_REJECTED` / `AUTH_PROFILE_NOT_FOUND` on all three routes. Hide the
   control rather than offering it and refusing — the same rule the *Reset bot memory* and
   *Send sign-in link* buttons already follow. A customer entry in `profiles` marked
   `missing: true` is the same 404.
2. **The current state is already on the page.** The customer entry of `profiles` now carries
   `codRestriction` (§ 5), so the badge and the choice of button need no extra request.
3. **Suspended and closed accounts are not refused.** Neither service checks the account's
   status here. Whether to offer the switch on a suspended account is a product choice — but
   it is not a button whose only outcome is an error.

### `AgencyDetail`

Beside the COD cash limit. The detail now carries `codRestriction` (§ 5). ⚠ **Show the
restriction next to the limit's headroom**: `headroom` is computed from amounts only, so a
restricted agency can show plenty of headroom and still receive no COD shipment.

### Both

- **A confirmation dialog with a required reason**, on restricting *and* on lifting (3–500
  characters). Say in one sentence what will happen and what will not (§ 1).
- **One button at a time**, chosen from `restricted`: *Restrict cash on delivery* when it is
  `false`, *Lift restriction* when it is `true`.
- Show the stored `reason`, `restrictedAt` and `restrictedByName` to administrators — and label
  the reason as internal.
- On success, replace the local state with the response body, toast `message`, and reload the
  **Activity** tab if it is open.

---

## 5 · Three additive read fields

### `GET /agencies/:agencyId` → `codRestriction`

```jsonc
"codRestriction": null
// or
"codRestriction": {
  "reason": "Three remittances short in two weeks",
  "restrictedAt": "2026-10-10T09:30:00.000Z",
  "restrictedByUserId": "66b0…",
  "restrictedBySource": "admin",
  "restrictedByName": "Ada Admin"
}
```

On the **detail only** — a row of `GET /agencies` does not carry it.

### `GET /users/:userId` → `profiles[]` customer entry → `codRestriction`

The same shape, `null` when not restricted.

⚠ **The key is present on the `customer` entry only.** On a vendor, agency or agent entry —
and on a `missing` one — it is **absent**, not `null`. `null` means "not restricted", and this
read does not look at an agency's restriction at all; that one is on the agency detail. Type
it as optional and read it from the customer entry.

### `GET /agencies/:agencyId/cod-limit` → `codRestricted`, `codRestrictedAt`

Two fields jovi-mall added to the report this route passes through: a boolean and an
ISO-8601 instant or `null`. No reason and no author here — use `codRestriction` or
`GET …/cod-restriction` for those.

---

## 6 · The audit rows

| Action | Appears in | Records |
|---|---|---|
| `users.cod.restrict` | `GET /users/:userId/activity` | The actor, the user, the `reason`, the outcome; `before` / `after` are `{ codRestricted }` — `false → true` |
| `users.cod.unrestrict` | `GET /users/:userId/activity` | The same, `true → false`, with the reason given for lifting |
| `agencies.cod.restrict` | `GET /agencies/:agencyId/activity` | As above, for the agency |
| `agencies.cod.unrestrict` | `GET /agencies/:agencyId/activity` | As above, for the agency |

- The row is written **before** jovi-mall is called and its failure is not caught. **If the
  audit store is down, nothing changes** — that is what a `500` on these routes means.
- A refused attempt (`409`) is recorded too, as a `failed` row carrying `COD_RESTRICTION_UNCHANGED`.
- ⚠ **The `unrestrict` row is the only lasting record of a restriction.** jovi-mall erases the
  restriction, its reason and its author when it is lifted, so once lifted the history exists
  *only* in the Activity tab. Do not build a "restriction history" from the read routes — they
  only ever know the current one.
- Both activity filters derive their vocabulary from the service, so the four names are already
  accepted as `?action=`. The dashboard's own lists need them and a label each:

```ts
// users
'users.cod.restrict': 'Cash on delivery restricted',
'users.cod.unrestrict': 'Cash on delivery restriction lifted',
// agencies
'agencies.cod.restrict': 'Cash on delivery restricted',
'agencies.cod.unrestrict': 'Cash on delivery restriction lifted',
```

The service's own one-line summaries (`GET /audit/actions`) are *"Switched cash on delivery off
for a customer"*, *"…back on for a customer"*, *"…off for a delivery agency"* and *"…back on
for a delivery agency"*.

The agency rows are marked `sensitive` (their permission is `financial`); the user rows are not.

---

## 7 · ⚠ The permission vocabulary and the route map

**Measured from `backend/admin` by running `npm run authz:matrix` and by loading the live route
manifest — re-measure rather than quoting these:**

| | Before | Now |
|---|---|---|
| Permission names | 140 | **142** |
| Tier totals (Dev / Admin / Support) | 140 / 118 / 47 | **142 / 120 / 47** |
| Families | 23 | **23** (unchanged) |
| Unrouted (`†`) | 4 | **4** (unchanged) |
| `users` family | 9 | **10** |
| `agencies` family | 5 | **6** |
| Routes on `/users` | 12 | **15** |
| Routes on `/agencies` | 13 | **16** |
| `users.*` audit actions | 8 | **10** |
| `agencies.*` audit actions | 6 | **8** |

Support's total does not move: neither new name is granted to tier 3.

What follows in the dashboard, in the order it will break once the mirror is re-copied:

1. **`permissions.types.ts`** — add `agencies.cod.restrict` (after `agencies.cod_limit.set`) and
   `users.cod.restrict`, and move the pinned counts: names `140 → 142`, routed `136 → 138`,
   tiers `142 / 120 / 47`.
2. **`ROUTE-MAP.md` and its test** — six new rows (the table in § 2), `/users` `12 → 15`,
   `/agencies` `13 → 16`, and the total up by six.
3. **`users.types.ts` / the agency equivalent** — the four audit actions and their labels (§ 6).
   No test forces this; the Activity filter is simply incomplete without it.

---

## 8 · Deliberate absences — do not build these

- **No bulk restrict, and no list of restricted accounts.** One customer or one agency at a
  time. Neither list endpoint filters on it, and the agency list row does not carry it.
- **No restriction for vendors or agents.** There are two subjects. A vendor's own COD terms
  and an agent's cash pool are different controls on other screens.
- **No history endpoint.** The read knows only the current restriction; the Activity tab is the
  history (§ 6).
- **No "notify the customer" option.** Nothing is sent, and the reason must not be forwarded.
- **No automatic restriction.** No counter of refused parcels flips this. It is a person's
  decision each time, which is why the reason is required.
- **Do not mirror the rule in the dashboard.** Whether a given basket or shipment may use cash
  on delivery is decided by jovi-mall at checkout and at every hand-off. The badge shows the
  switch; it does not predict an outcome.

---

## Checklist

- [ ] `users.service.ts`: `getCodRestriction(userId)`, `restrictCod(userId, { reason })`, `liftCodRestriction(userId, { reason })`
- [ ] The same three on the agencies service
- [ ] One shared type: `CodRestrictionReport { subject, subjectId, userId, restricted, restriction }` and `CodRestriction { reason, restrictedAt, restrictedByUserId, restrictedBySource, restrictedByName }`
- [ ] `UserDetail`: badge + button, gated on `users.cod.restrict` **and** the customer role
- [ ] `AgencyDetail`: badge + button beside the COD limit, gated on `agencies.cod.restrict`
- [ ] A reason dialog (3–500, **required for restrict and for lift**); send `{ reason }` and nothing else
- [ ] `409 COD_RESTRICTION_UNCHANGED` → re-fetch and show the stored restriction, not an error toast to retry
- [ ] `AUTH_PROFILE_NOT_FOUND` copy if the switch is ever reachable for a non-customer
- [ ] Types: `codRestriction` on the agency detail and (optional) on a profile entry; `codRestricted` / `codRestrictedAt` on the COD-limit report
- [ ] Never render `reason` anywhere the customer or the agency can see it
- [ ] ⚠ Re-copy the doc mirror; `permissions.types.ts` `140 → 142`; `ROUTE-MAP.md` +6 rows
- [ ] The four audit actions and their labels in the two Activity filters

# Admin dashboard — "the bot is confused": resetting a customer's chat memory

> **Date:** 2026-09-22 · **Audience:** the admin dashboard · **Breaking:** ⚠ **nothing on the
> wire** — but **four dashboard test suites go red** the moment the doc mirror is re-copied, and
> that is deliberate (§ 5). Nothing in this instalment changes an existing request or response.
>
> The backend change: wi-admin `d09e608`, jovi-mall `6008fda`.
> The contract pages: [`api/users.md`](./api/users.md#the-customer-bots-memory) ·
> [`api/permissions.md`](./api/permissions.md)

| # | Change | Kind |
|---|---|---|
| 1 | **New button** on a customer's page: *Reset bot memory* | additive |
| 2 | New endpoint `POST /api/v1/users/:userId/bot-memory/reset` | additive |
| 3 | New permission **`users.bot_memory.reset`**, held by **all three levels** — Support included, on purpose | additive |
| 4 | New audit action `users.bot_memory.reset` on the user activity feed | additive |
| 5 | ⚠ **The permission vocabulary moves 121 → 124** and the waiting room (`permissions.pending.ts`) empties. Three suites break until it is re-mirrored | **chore, unavoidable** |
| 6 | ⚠ `ROUTE-MAP.md` is **five rows** behind the service, not four | chore |

---

## 1 · What this is, in plain language

Customers talk to the platform through a bot on WhatsApp and Telegram. The bot keeps a short
memory of each customer's chat so it can follow a conversation across several messages.

Sometimes that memory is the problem. The customer cancelled an order and the bot keeps quoting
it; a bargaining session went sideways; the bot latched on to the wrong product and will not let
go. The customer opens a Support ticket saying *"the bot is confused"*.

**This is the remedy: one button that makes the bot start that person's next conversation from
nothing.**

What it does **not** do, and the screen should say so:

- It **deletes no order, no message record, no account field and no credential.** Nothing the
  platform keeps about the person is touched.
- It does **not** sign anybody out, suspend anything, or change what the customer can do.
- It is **not** destructive and **not** reversible in a way anyone would miss — the worst a wrong
  press can do is have one customer's next message answered without memory of the last chat,
  which is how every new customer starts.

Pressing it twice is harmless: two presses mean two resets and two audit rows.

> **How it works underneath, only because it explains `memoryEpoch` below.** jovi-mall does not
> hold the chat memory — the automation layer does. What jovi-mall holds is a **counter** per
> customer. A reset adds one to the counter, the automation layer folds the counter into the key
> it stores the memory under, and the old memory becomes unreachable from the customer's very
> next message. You do not need any of this to build the button. You need it to know that
> `memoryEpoch` is a number that only ever goes up, and means nothing on its own.

---

## 2 · The endpoint

```http
POST /api/v1/users/:userId/bot-memory/reset
Content-Type: application/json

{ "reason": "Customer says the bot keeps quoting an order they cancelled" }
```

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Optional.** Trimmed, 3–500 characters. Recorded on the audit row |

- The body is **strict**: any key other than `reason` is a `400 VALIDATION_ERROR`.
- An empty body is valid — send `{}` or nothing at all.
- ⚠ **Omit the key rather than sending `""`.** An empty string is a `400`, so a dialog with an
  untouched optional textarea must not post `reason: ""`. (`clearable()` semantics do **not**
  apply here — this is not a PATCH field.)
- Cookie-authenticated calls send the CSRF header, as on every other write. The existing API
  client already does this; nothing new.

### Response `200`

```jsonc
{
  "success": true,
  "data": {
    "userId": "665f1c2a9b3e4a91c7d2e5f0",
    "memoryEpoch": 4,
    "resetAt": "2026-09-22T10:00:00.000Z"
  },
  "message": "Bot memory reset — the next conversation starts fresh"
}
```

| Field | Type | Show it as |
|---|---|---|
| `userId` | string | The account that was reset. Echo only |
| `memoryEpoch` | number | jovi-mall's counter. **Treat it as opaque** — display it if you like ("4th reset"), never compute with it, never compare two users' |
| `resetAt` | ISO-8601 | When it happened. Format in the administrator's timezone, as elsewhere |

Exactly these three fields — wi-admin names them one by one, so nothing jovi-mall might add later
reaches the client. A success toast carrying `message` is enough; there is no panel to refresh.

### Errors

| Status | Code | What the screen should say |
|---|---|---|
| `400` | `VALIDATION_ERROR` | A malformed user id, a `reason` outside 3–500 characters (`""` included), or an unknown key. Field-level, as everywhere |
| `403` | `AUTHZ_PERMISSION_DENIED` | The caller lacks the permission. **No level lacks it today**, so if you see this, `/permissions/me` and the button's gate disagree |
| `404` | `NOT_FOUND` | No such user. Checked by wi-admin **before** jovi-mall is called |
| `404` | `PLATFORM_OPERATION_REJECTED`, `details.platformCode: "AUTH_PROFILE_NOT_FOUND"` | ⚠ **The one worth writing copy for — see § 4.** The account exists and has **no customer profile**: this person has never talked to the bot as a customer, so there is no memory to forget |
| `4xx` | `PLATFORM_OPERATION_REJECTED` | Any other jovi-mall refusal. Its status is kept and its code is in `details.platformCode` |
| `500` | `INTERNAL_SERVER_ERROR` | The audit trail could not record the attempt. **Nothing was reset** — jovi-mall is not called until the audit row exists |
| `502` / `503` | `SERVICE_DEPENDENCY_UNAVAILABLE` | jovi-mall failed or is unreachable. A write is **never retried automatically**, so the reset *may* not have happened. **Pressing again is safe** — say so in the error copy |

---

## 3 · The permission, and why Support holds it

**`users.bot_memory.reset` — held by Developer, Admin *and* Support.**

⚠ **This is the only write on the `/users` surface that Support holds, and it is deliberate.**
Every other write there — suspend, restore, edit identifiers, password-reset link, sign-in link —
is Admin and above. Do not "tidy" the gate to match its neighbours.

The reasoning, so that nobody narrows it by accident later: the complaint arrives as a Support
ticket, and this is the remedy, so it should be pressable at the level that received the ticket.
It is safe at that level because it touches nothing the platform keeps about the person. Contrast
the two credential routes beside it — either one can hand an account to whoever opens the message,
which is why Support holds neither.

It also carries **no flag**: not `financial`, not `destructive`, not `escalation`, no dual
control. `destructive` would have made wi-admin's boot check refuse it to Support outright, and
the flag would have been a lie — it hard-deletes nothing.

**Gate the button on `users.bot_memory.reset` from `GET /permissions/me`, not on tier.** Today
that resolves to "everyone", but the gate is the contract and the grant is not.

---

## 4 · Where it goes on screen

**`UserDetail` → the action bar**, beside *Send reset link* / *Send sign-in link* / *Message on
Telegram*.

Three rules, in order of how easy each is to get wrong:

1. **Customers only.** Gate it on `record.roles.includes('customer')` — *exactly* the rule the
   *Send sign-in link* button already uses two lines away. The bot's memory lives on the
   customer profile, so an account with no customer role answers
   `404 PLATFORM_OPERATION_REJECTED` / `AUTH_PROFILE_NOT_FOUND`. Hide the button rather than
   offering it and refusing. (If you want the finer signal, the detail's `profiles` array carries
   the customer entry — and `isMissingProfile()` marks a role the `users` row claims whose entity
   does not exist. A `missing: true` customer entry is the same 404 case.)

2. **Suspended and closed accounts are NOT refused.** ⚠ This is the opposite of the credential
   buttons, which are hidden on both because the platform answers `AUTH_ACCOUNT_SUSPENDED`. There
   is no such guard here — jovi-mall checks that the user exists and nothing else — so the reset
   works on a suspended or closed account. Whether to offer it there is a product choice; what it
   is **not** is a button whose only outcome is an error, so do not copy the
   `status !== 'suspended' && !closed` condition across without deciding.

3. **A confirmation step, with an optional reason.** The action is cheap but it is audited and it
   is visible to the customer on their next message, so it should not be a bare one-click. A
   small dialog: one sentence of what will happen, an optional *Reason* field (3–500 characters,
   **omit the key when empty**), *Cancel* / *Reset memory*.

**Copy that matters.** Do not call this "clear chat history" or "delete messages" — administrators
will read that as *the conversation is gone*, and it is not: the message records are untouched.
Something closer to *"Make the bot forget this customer's chat"*, with a line of body text saying
orders, messages and the account are not affected.

**No panel to refresh.** Nothing on the detail screen reflects the epoch, so a success toast is
the whole feedback. Reload the **Activity** tab if it is open, since the write just put a row in
it (the screen already does this for the other writes).

---

## 5 · ⚠ The permission vocabulary, and the four suites this trips

This is the part that will take the time, and none of it is caused by the button.

`src/types/permissions.types.ts` hard-codes the permission **names** and its test diffs them
against the mirrored `api-doc/admin/api/permissions.md`. That document had **already drifted**
before today, and it is **being corrected in the same batch as this changelog** — so when you
re-copy the mirror you will absorb three new names at once, not one.

**Measured from `backend/admin` at this commit, by executing `npm run authz:matrix` and by
counting `defineRoute` calls in `src/` — re-measure rather than quoting these:**

| | Dashboard has | Service has |
|---|---|---|
| Permission names | 121 | **124** |
| Tier totals (Dev / Admin / Support) | 121 / 101 / 31 | **124 / 104 / 38** |
| Unrouted (`†`) | 4 | **4** (unchanged) |
| Routed | 117 | **120** |
| Families | 21 | **21** (unchanged) |
| `ROUTE-MAP.md` total | 256 | **261** documentable routes (262 `defineRoute`, less the one excluded internal) |
| `ROUTE-MAP.md` `/users` | 8 | **9** |

### The three names

| Name | Tiers | Flags | Where it is documented |
|---|---|---|---|
| `users.bot_memory.reset` | 1 · 2 · 3 | — | [`api/users.md`](./api/users.md#the-customer-bots-memory) — this changelog |
| `cod.triage` | 1 · 2 · 3 | — | [`api/cod.md`](./api/cod.md) — ADR-024, shipped 2026-09-16 |
| `money.payouts.triage` | 1 · 2 · 3 | `financial` | [`api/money.md`](./api/money.md) — ADR-024, shipped 2026-09-16 |

The two `triage` names are **not new work for you** — the dashboard already implements both
screens (`CodTriageDialog`, `PayoutTransferDialogs`) through the `permissions.pending.ts` waiting
room. What is new is that `permissions.md` finally publishes them, which is the condition that
file's own guard was written to detect.

`money.payouts.triage` is `financial` **and** held by Support, which normally cannot happen. It is
admitted by a named exemption in the service's grant table (`TIER_3_FINANCIAL_ALLOWLIST`) because
a reviewer's rejection returns money to the owner's balance. Nothing to build; worth knowing
before someone "fixes" it.

### Four tier-3 **grants** that also changed (no new names)

Support now additionally holds `cod.overview.read`, `cod.remittances.read`, `cod.deposits.read`
and `money.payouts.read`. These are existing names the dashboard already declares, so no
transcription is needed — but **Support can now reach COD and payout read screens they previously
could not**, and the nav will start showing those sections to tier 3. Check that nothing on those
screens assumes its reader holds a write permission. ⛔ `money.payouts.destination.read` is **not**
among them and must not be treated as if it were: the full beneficiary number stays out of
Support's reach.

### What breaks, and in what order

1. **`src/types/permissions.types.test.ts`** — *"declares every documented permission, and no
   others"* fails with the three names, and the hard-coded counts fail:
   `PERMISSION_NAMES.length` `121 → 124`, and `121 - 4 = 117` → `124 - 4 = 120`.
   Also *"states the same counts in prose"*, which re-derives the tier totals from the matrix.

2. ⚠ **`src/types/permissions.pending.test.ts` — the failure this file was written to produce.**
   It asserts `doc.includes('`cod.triage`') === false`, and the corrected `permissions.md` now
   publishes both triage names as real matrix rows (and names them in a warning banner at the top
   too, so it would have fired on the banner alone). **Nothing is broken when this goes red** —
   the waiting room's whole purpose is to empty. Do not weaken the assertion. Move both names into
   `PERMISSION_NAMES`, switch their call sites from `usePendingPermission()` to `can()`, and
   **delete `permissions.pending.ts` and its test** — the file's own docstring says it is designed
   to be deleted.

3. **`src/types/route-map.test.ts`** — *"names nothing absent from `PERMISSION_NAMES`"* passes
   only after step 1. Then `expect(totalDeclared).toBe(256)` is the assertion that exists to fire
   when routes arrive. Five have:

   | Route | Permission | Audit | Documented in |
   |---|---|---|---|
   | `POST /users/:userId/bot-memory/reset` | `users.bot_memory.reset` | `users.bot_memory.reset` | [`api/users.md`](./api/users.md) |
   | `POST /cod/deposits/:depositId/triage` | `cod.triage` | `cod.triage` | [`api/cod.md`](./api/cod.md) |
   | `POST /cod/remittances/:remittanceId/triage` | `cod.triage` | `cod.triage` | [`api/cod.md`](./api/cod.md) |
   | `POST /money/payouts/:payoutId/triage` | `money.payouts.triage` | `money.payouts.triage` | [`api/money.md`](./api/money.md) |
   | `POST /money/payouts/:payoutId/send` | `money.payouts.mark_paid` | `money.payouts.mark_paid` | [`api/money.md`](./api/money.md) |

   Add all five rows, move `/users` from 8 to 9, `/cod` and `/money` by two each, and take the
   total to **261** — in the title, in the *"by namespace"* heading and in the test's pin. The
   four non-bot-memory rows were already listed in that file's own header as known-missing and
   held back only because their permissions were undeclared; that blocker is now gone.

4. **`src/types/users.types.ts`** — `USER_AUDIT_ACTIONS` and `USER_AUDIT_ACTION_LABELS` gain a
   sixth entry (§ 6). No test forces this; the filter is simply incomplete without it. Note the
   existing docstring says *"Exactly three today"* and already lists five — correct it while you
   are there.

---

## 6 · The audit row

| Action | Sensitive | Records |
|---|---|---|
| `users.bot_memory.reset` | — | The actor, the target user, the optional `reason` (as `null` when none was given), the outcome, and on success `after: { memoryEpoch, resetAt }`. `before` is `null` — the account itself did not change |

- The row is written **before** jovi-mall is called, and its failure is not caught. **If the audit
  store is down, nothing is reset.** That is why a `500` on this route means "nothing happened".
- It appears in `GET /users/:userId/activity`, which every level can read (`users.read` +
  `audit.read`), so the Activity tab needs the filter vocabulary and a label:

```ts
'users.bot_memory.reset': 'Bot memory reset',
```

The action name is identical to the permission name. That is not a mistake; the service names
several that way.

---

## 7 · Deliberate absences — do not build these

- **There is no "what does the bot remember?" read.** No endpoint exposes the memory, and none is
  planned: the memory lives in the automation layer, not in any service the dashboard talks to.
  A screen that offers *View* beside *Reset* has nothing to call.
- **There is no bulk reset and no reset-by-channel.** One user, all their chats, both channels.
  The request body has one optional field for a reason and nothing else to choose.
- **`memoryEpoch` is not a metric.** It is not on the user list, not on any read, and not
  comparable between users. It comes back on the write only so the operator can see something
  happened.
- **Support holding this write is not a precedent.** It is a one-off with a written reason
  (§ 3). Do not generalise it to the other `users.*` writes in a permission helper.
- **`files.library.read` is still not audited** and **`money.payouts.destination.read` is still
  not Support's** — two nearby things people ask about when they see a permission move. Neither
  changed.

---

## Checklist

- [ ] `users.service.ts`: `resetBotMemory(userId, { reason? })` → `POST /users/:userId/bot-memory/reset`
- [ ] `users.types.ts`: `BotMemoryResetResult { userId, memoryEpoch, resetAt }`
- [ ] `UserDetail` action bar: *Reset bot memory*, gated on `users.bot_memory.reset` **and** the customer role
- [ ] Confirmation dialog with an optional `reason` (3–500 chars; **omit the key when empty**)
- [ ] Success toast from `message`; reload the Activity tab if open
- [ ] Error copy for `AUTH_PROFILE_NOT_FOUND` ("this account has never used the bot") and for `503` ("it may not have happened — pressing again is safe")
- [ ] ⚠ Re-copy the doc mirror (`api-doc/admin/`, `api-doc/docs/`) from `backend/admin`
- [ ] ⚠ `permissions.types.ts`: +3 names, counts `124` / `120`, tiers `124 / 104 / 38`
- [ ] ⚠ Empty and **delete** `permissions.pending.ts` + `permissions.pending.test.ts`; move both triage call sites to `can()`
- [ ] ⚠ `ROUTE-MAP.md`: +5 rows, `/users` 8→9, total 256→**261**, and the pin in `route-map.test.ts`
- [ ] `USER_AUDIT_ACTIONS` + `USER_AUDIT_ACTION_LABELS`: `users.bot_memory.reset` → "Bot memory reset"
- [ ] Sanity: a tier-3 account now sees the COD and payout **read** screens — check they degrade without write permissions

---

## For the dashboard session — paste this

> Copy everything below the line into the `admin-dash` session. It is self-contained.

---

You are working in **`C:\Users\Fante\Desktop\projects\wi-mall\frontend\admin-dash`** — the admin
dashboard (React + Vite + TypeScript + vitest). The backend, `backend/admin` (wi-admin), is **read-only
to you**: read its source and docs freely, never edit them, and never edit anything under
`backend/`. If the backend looks wrong, say so in your report — do not fix it here.

**Read these first, in this order:**

1. `backend/admin/api-doc/FRONTEND-CHANGELOG-bot-memory-reset.md` — the brief for this task. Read
   all of it, especially § 5.
2. `backend/admin/api-doc/api/users.md` § *"The customer bot's memory"* — the endpoint contract.
3. `backend/admin/api-doc/api/permissions.md` — the corrected permission matrix.
4. Your own `src/types/permissions.pending.ts` docstring — it tells you exactly what to do when
   its guard goes red, and that day is today.

**Task 1 — re-mirror the contract.** Re-copy `backend/admin/api-doc/` → `api-doc/admin/` and
`backend/admin/docs/` → `api-doc/docs/`, the way the mirror is always refreshed (byte copy;
`ADR-023-ADMINISTRATOR-EMPLOYEE-RECORD.md` is missing from the docs mirror and should come across
too). ⛔ Never hand-edit a mirrored file to make a test pass — a mirror is re-copied or it is wrong.

**Task 2 — absorb the vocabulary.** Three permission names arrive at once:
`users.bot_memory.reset`, `cod.triage`, `money.payouts.triage`. In `src/types/permissions.types.ts`
add all three in their families' positions and update the count assertions in
`permissions.types.test.ts`: `PERMISSION_NAMES.length` 121 → **124**, routed 117 → **120**, tiers
**124 / 104 / 38**, unrouted stays 4, families stay 21. **Verify by running
`npm run authz:matrix` in `backend/admin` — do not trust my numbers or the document's.**

Then **empty the waiting room**: move `cod.triage` and `money.payouts.triage` out of
`permissions.pending.ts`, switch their call sites (`CodTriageDialog`, `DepositDetail`,
`RemittanceDetail`, `PayoutDetail`, `PayoutsQueue`, `cod.service.ts`, `money.service.ts`) from
`usePendingPermission()` to `can()`, and **delete `permissions.pending.ts`,
`permissions.pending.test.ts` and `src/hooks/use-pending-permission.ts`**. That file's docstring
says it is designed to be deleted; this is the day.

**Task 3 — the route map.** `api-doc/ROUTE-MAP.md` is five rows behind. Add
`POST /users/:userId/bot-memory/reset`, the two `/cod/.../triage` routes, `POST /money/payouts/:id/triage`
and `POST /money/payouts/:id/send` (the last four are already listed as known-missing in that
file's own header, and were blocked only on the permission names you just added). Move `/users`
8 → 9, `/cod` and `/money` by two each, and the total 256 → **261** in the title, the
*"by namespace"* heading and the `expect(totalDeclared).toBe(...)` pin in `route-map.test.ts`.
Re-run the file's own "Reproducing this table" recipe if you can; otherwise mark the new rows as
read-from-source, as that file already does for others.

**Task 4 — build the button.** On `src/pages/users/UserDetail.tsx`, in the action bar beside
*Send sign-in link*:

- `POST /api/v1/users/:userId/bot-memory/reset`, optional `{ reason }` (trimmed, 3–500 chars,
  **omit the key when empty** — `""` is a 400; the body is strict, so send nothing else).
- Returns `{ userId, memoryEpoch, resetAt }` plus a `message`. `memoryEpoch` is opaque.
- Gate on the permission `users.bot_memory.reset` (`<Can>`) **and** on
  `record.roles.includes('customer')` — same rule the sign-in-link button uses, because a
  non-customer answers `404 PLATFORM_OPERATION_REJECTED` with
  `details.platformCode: "AUTH_PROFILE_NOT_FOUND"`.
- ⚠ Unlike the credential buttons, this is **not** refused on a suspended or closed account.
  Decide deliberately whether to offer it there; do not copy the
  `status !== 'suspended' && !closed` condition across without a reason.
- Confirmation dialog, optional reason, success toast from `message`, reload the Activity tab if
  open. Copy must not say "delete messages" or "clear chat history" — no message record, order or
  account field is touched. Something like *"Make the bot forget this customer's chat"*.
- Error copy for `AUTH_PROFILE_NOT_FOUND` and for `503` ("the reset may not have happened;
  pressing again is safe"). Add `AUTH_PROFILE_NOT_FOUND` to `src/i18n/locales/{en,fr}/error-platform.ts`
  if you keep the button visible for non-customers.

**Task 5 — the activity feed.** `USER_AUDIT_ACTIONS` and `USER_AUDIT_ACTION_LABELS` in
`src/types/users.types.ts` gain `'users.bot_memory.reset': 'Bot memory reset'`. Fix the stale
"Exactly three today" line in that docstring while you are there.

**Task 6 — the tier-3 widening.** Support now also holds `cod.overview.read`,
`cod.remittances.read`, `cod.deposits.read` and `money.payouts.read` (no new names — existing ones
newly granted). Those nav sections will start appearing for tier 3. Check the COD and payout
**read** screens degrade cleanly for a reader with no write permission there. ⛔
`money.payouts.destination.read` is still **not** Support's — do not widen anything that reveals a
beneficiary account number.

**Acceptance:**

- `npm run typecheck` and `npm run lint` clean.
- `npm test` (`vitest run`) green — in particular `permissions.types`, `route-map`, `error-catalog`,
  `notification-path`, `content-blocks`, `content-contract`, `UserDetail`, `CodScreens`,
  `PayoutsQueue`, `PayoutDetail`.
- `permissions.pending.ts` and `permissions.pending.test.ts` are **gone**, not weakened.
- A test on `UserDetail` proving the button is **hidden** without `users.bot_memory.reset`, and
  **hidden** on a non-customer account even with it.
- A test proving the dialog posts no `reason` key when the field is left empty.
- No file under `backend/` modified — `git status` in `backend/admin` and `backend/jovi-mall` clean
  of your changes.

**Standing constraints:** the backend is not yours to change; `api-doc/admin/` and `api-doc/docs/`
are byte mirrors, never hand-edited; the level → permission matrix comes only from
`GET /permissions/me` at runtime, never from a hard-coded tier table in `src/`.

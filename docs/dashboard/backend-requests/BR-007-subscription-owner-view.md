# BR-007 · An owner-scoped view of subscriptions

**Priority: medium.** The screen can be built, but only over one page at a time — which for the
question being asked is structurally a partial answer.

## The ask

> Can a user have more than one subscription plan? Displaying this detail on the Subscription tab
> should put the most active plan at the top and the expired ones directly below it. And the change-plan
> action should only be performable on the active plan.

## The answer to the first half: yes, and the contract says so twice

An owner can hold several subscription rows at once.

[`billing.md`](../../admin/api/billing.md) gives `GET /billing/subscriptions` a stated purpose:

> *"Which owners have a plan queued behind their current one — `status=pending_activation`. **That is
> the state that silently becomes active without anybody acting.**"*

And `POST /billing/subscriptions/:ownerType/:ownerId` *"expires the current term, grants the credit
allowance exactly once inside the same transaction that activates the new one"* — so assigning a plan
to an owner whose paid term has not lapsed produces a **second, queued row**, and answers `409` with
`details.platformCode: "BILLING_PENDING_PLAN_EXISTS"`.

So: **one active term, but many rows** — one `active`, optionally one `pending_activation`, plus the
history.

## What exists today

| | |
|---|---|
| `GET /billing/subscriptions` | Cross-owner list. Filters `status`, `ownerType`, `ownerId`, `planId`, `planCode`, `expiringBefore`, `from`/`to`. Sorts on `createdAt`, `startedAt`, `expiresAt`, `updatedAt` |
| `GET /billing/plans/:planId/subscribers` | Same rows, scoped to one plan |
| `POST /billing/subscriptions/:ownerType/:ownerId` | Assign. Body `{ planId, paymentReference? }` |

**There is no `GET /billing/subscriptions/:subscriptionId`,** and no owner-scoped read. There is also
no cancel, suspend or refund — the whole billing mount is eight routes.

Two things make a client-side answer inherently partial:

1. **The list is server-paginated.** An owner's rows can straddle a page boundary, so grouping the
   rows on screen groups *some* of their terms. The screen cannot know it is incomplete.
2. **`status` is not a pinned enum.** *"The platform's vocabulary; not pinned — this service never
   writes a status."* Only `active` and `pending_activation` appear anywhere in the docs. So "which
   row is the live one" is a client heuristic over an open vocabulary, and a value added upstream next
   quarter changes the answer silently.

## What the dashboard does in the meantime

- Sorts the current page by owner, then by a **status rank** — `active`, then `pending_activation`,
  then anything unrecognised, then `expired`/`cancelled` — and within that by `startedAt` descending
  with `null` last (`null` means queued, not old).
- The rank function falls through gracefully on an unknown status and never `switch`es exhaustively;
  an unrecognised value is ranked as history and **never dropped**.
- **Change plan is enabled on exactly one row per owner** — the `active` one; if the owner has none on
  this page, the most recent, labelled as such. Every other row of that owner carries a withheld
  affordance explaining that a plan change replaces the live term, not that row.
- It pre-empts `BILLING_PENDING_PLAN_EXISTS` when a `pending_activation` row is already visible for
  that owner.
- It **says on screen that the grouping covers the current page**, and the owner cell links to the
  same list filtered by `ownerType` + `ownerId` — which *is* server-side and complete.
- It does not infer "current" from `expiresAt`. `expiresAt: null` is the never-expiring free tier, not
  unknown.

## The proposed contract

Either of these solves it. The first is smaller; the second is better.

### Option A — `GET /api/v1/billing/subscriptions/:subscriptionId`

Permission `billing.plans.read`. Returns the same row shape, plus whatever the list omits (the
platform's `subscriberPlan` record has more on it than the list projection carries — at minimum the
credit grant and the transition it came from).

This makes a subscription **addressable**, which it is not today: an operator cannot link a colleague
to one, and a `paymentReference` in a support ticket has nowhere to point.

It does **not** answer the ordering question.

### Option B — an owner-scoped read (recommended)

```
GET /api/v1/billing/subscriptions/:ownerType/:ownerId
```

Permission `billing.plans.read`. Same path shape as the existing `POST`, so assign and read are
symmetric.

```jsonc
{
  "success": true,
  "data": {
    "owner": { "type": "vendor", "id": "665a…", "name": "Douala Fresh Market" },
    "current": { …subscription… },          // the live term, or null
    "queued":  { …subscription… },          // pending_activation, or null
    "history": [ …subscriptions… ]          // everything else, newest first
  },
  "meta": { "total": 7 }
}
```

**The value is that `current` is the platform's answer, not a client heuristic.** The service writes
these statuses and knows which term is live; a dashboard ranking an open vocabulary is guessing, and
it guesses over one page.

`history` may be paginated with the usual `page`/`limit` if an owner can accumulate many terms;
`current` and `queued` are single objects and never paginate.

`current: null` means no active plan — the same fact `GET /accounts/:ownerType/:ownerId` reports by
setting the whole `subscription` block's fields to `null` together.

### While you are in there — two smaller things

- **Document the status vocabulary**, even as an open list. `billing.md` names `pending_activation`
  in prose and `active` in an example, and nothing else. The four the model carries are
  `active`, `pending_activation`, `expired`, `cancelled`. Writing them down as *"known members, open
  for a fifth"* costs nothing and stops every client guessing differently.
- **`BILLING_PENDING_PLAN_EXISTS` is undocumented** and reachable on a completely normal path — an
  operator assigning a plan to an active subscriber gets it every time. `billing.md` lists only
  `BILLING_PLAN_INACTIVE` and `BILLING_PLAN_ROLE_MISMATCH`. Add it.

## Acceptance

- [ ] An owner-scoped read exists, returning `current` / `queued` / `history` as the platform's own
      determination.
- [ ] `current: null` is distinguishable from "we could not determine it".
- [ ] `GET /billing/subscriptions/:subscriptionId` exists, or a note records why it does not.
- [ ] The subscription status vocabulary is written down in `billing.md` as an open list.
- [ ] `BILLING_PENDING_PLAN_EXISTS` is documented on the assign route and added to `errors.md`.

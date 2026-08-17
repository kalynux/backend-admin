# ADR-017 — Phase 17 close-out

**Date:** 2026-08-18 (evidence gathered 2026-08-17)
**Status:** Open — D-1 accepted; the rest is written as Phase 17 closes
**Scope:** wi-admin
**Record for:** [`PHASE-17-LEGACY-PORT-PLAN.md`](./PHASE-17-LEGACY-PORT-PLAN.md) and
[`PHASE-17-STATUS.md`](./PHASE-17-STATUS.md), which carry the working detail

---

## Why this file exists now, half-empty

Phase 17's plan and status page are working documents — they track what is ported, what is left,
and what is deliberately unbuilt. What they are not is the place a *decision* is recorded, and
one of their rows has been asking for one in writing since the phase opened: `customers.read` ·
`customers.suspend`, **"the only pair with no written rationale anywhere"**.

That is D-1. The remaining close-out decisions (Part 5.E's forced deletions, the `phase` union
widening, what `LEGACY_ENDPOINT_COUNT = 0` obliges) land here as they are taken.

---

## D-1 · `customers.read` and `customers.suspend` are deleted from the catalog

**Decision: remove both permissions.** Not "unbuilt with a rationale" — removed.

### What was verified before deciding

- Both are catalogued at `phase: 6` under a header that already concedes the point:
  `// ═══ CUSTOMERS ═══ no admin surface today` — `permission.catalog.ts:641-649`. **Neither has
  an endpoint.**
- **Both are granted.** Tier 2 Admin holds them via `allInFamily('customers')`
  (`tier-grants.ts:152`), and Tier 3 Support is granted `customers.read` **by name**
  (`tier-grants.ts:68`). `docs/api/permissions.md:265-266` publishes both with the grant matrix.
- **The `users` module already covers customers, role-agnostically.** `USER_ROLES` is
  `['vendor','agency','agent','customer']` (`users/validators/user.validator.ts:26`), so
  `GET /users?role=customer` *is* the customer directory; `GET /users/:userId` composes a
  `customer` role-profile (`role-profile.read.repository.ts:55`);
  `POST /users/:userId/{suspend,restore}` is the suspension, audited as `users.suspend` /
  `users.reinstate`. Order history is `orders.read` filtered by `customerId`.
- The catalogued summary — *"Search customers and view their detail and order history"* — is
  therefore served in full, by two permissions every tier that would hold `customers.read`
  already has.

### Why deletion rather than the unbuilt list

The other four entries on that list (`users.sessions.revoke`, `users.roles.manage`,
`notifications.manage`, `developer_tools.webhooks.redeliver`) are **grants nobody holds** —
absent from `tier-grants.ts` entirely. These two are **live grants backing no route**. That
difference is the whole argument: a granted permission with no endpoint appears in an
administrator's effective permission list and in the dashboard's permission screen, promising a
customers surface that does not exist. Leaving it catalogued with a rationale documents the
promise instead of withdrawing it.

### What the change touches

Phase 5.E does the edit; it is listed here so the diff is not a surprise.

| File | Edit |
|---|---|
| `src/modules/authorization/domain/permission.catalog.ts` | delete both entries and the `CUSTOMERS` block header |
| `src/modules/authorization/domain/tier-grants.ts` | delete `'customers.read'` from `SUPPORT`; delete `allInFamily('customers')` from the tier-2 union |
| `docs/api/permissions.md` | delete the `customers` section |
| `PHASE-17-STATUS.md` · `PHASE-17-LEGACY-PORT-PLAN.md` | the unbuilt-list row now points here |

Check the catalog-size and tier-grant assertions in `test:authz` / `verify:authz` in the same
change — the permission count moves by two.

### Consequence

No capability is lost. An administrator searching for a customer uses `users.read` with
`?role=customer`; suspending one uses `users.suspend`, which is the same account lock with the
same audit action and the same compare-and-set. What is lost is a second name for it.

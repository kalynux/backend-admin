# ADR-003 — Granular permissions in code, granted by tier

**Status:** Accepted, 2026-08-10 · **Supersedes:** ADR-001 Decision 5 (in part), blueprint D8 (in part)
**Implemented by:** Phase 3 (Authorization & RBAC)

---

## Context

ADR-001 Decision 5 chose **fixed tiers with a static tier→ENDPOINT map**: each route declares
`minTier`, there is no permission catalog, and there are no per-admin overrides. That decision
dropped three collections from the Phase-0 design — `admin_permissions`, `admin_tier_grants`,
`admin_permission_overrides` — on the reasoning that authorization should be *code, not data*, and
that "every endpoint's required tier is greppable in one file".

It also, explicitly, overrode a stated requirement. `PHASE-0-DISCOVERY.md:371` calls tier→permission
mapping as data "the brief's requirement", and `PHASE-0:266-268` records the honest finding behind
it: *"There are no granular permissions. The task brief says 'use granular permissions wherever the
existing platform supports them' — the honest answer from discovery is that the platform supports
none for administrators. Every permission primitive must be built."*

The Phase 3 brief restated the requirement and sharpened it:

> Prefer granular permissions where appropriate. […] **Never rely solely on tier checks when a
> resource-specific permission is required.**

A `minTier` number on a route cannot express that. It is a single scalar; there is no "resource-
specific permission" for it to be checked alongside.

## Decision

**Granular permissions, defined in code. Tiers grant permission sets, in code. No per-admin
overrides, no policy collections.**

- `src/modules/authorization/domain/permission.catalog.ts` — one frozen catalog. Every operation the
  service will ever authorize is named `family.resource.action` and carries a summary, a phase, and
  flags (`financial`, `escalation`, `destructive`, `scope`, `dualControl`).
- `tier-grants.ts` — three permission sets, one per level, built from `allInFamily()` expansions plus
  explicitly named sensitive permissions.
- Routes declare `permission('cod.remittances.confirm')`, never a tier number.

`PermissionName` is derived from the catalog's keys, so a misspelled permission is a **compile
error**, not a route that fails closed in production on a path nobody tested.

## What this keeps from Decision 5, and what it changes

**Kept — the property Decision 5 was actually buying:**

| Decision 5 property | Still true |
|---|---|
| Policy is code, not data | Yes — one file, no collections |
| Not editable at runtime | Yes — `Object.freeze`, no admin API writes policy |
| Greppable in one place | Yes — the catalog and the grant table |
| No per-admin overrides | Yes — an administrator's level is their entire authorization state |
| Three collections stay dropped | Yes — `admin_permissions`, `admin_tier_grants`, `admin_permission_overrides` are not revived |

**Changed — the unit of authorization.** A route declares *what it does*, not *who may reach it*.
That is what makes the brief's requirement expressible, and it has three consequences Decision 5
could not deliver:

1. **Reads and writes stop sharing a guard.** `PHASE-0:274` flags that
   `GET /admin/cod/overview` and `POST /admin/cod/deposits` sit behind the identical check today.
   They now carry different permissions, and `allInFamily()` structurally refuses to expand a
   `financial` one — a family grant cannot sweep in a write that moves money.
2. **Permission and resource are separable.** `administrators.suspend` says an administrator may
   suspend administrators; `escalation.rules.ts` says which ones. Holding the permission is
   necessary, never sufficient.
3. **Policy survives a reorg.** `cod.remittances.confirm` stays true when levels are renamed or a
   fourth is added. `minTier: 2` does not.

**Cost.** ~95 permission names to maintain instead of 81 endpoint→tier rows, and a grant table that
must be edited when a permission is added. The boot assertion turns that cost into a guarantee: the
service refuses to start if a permission is granted to nobody, if an escalation permission is granted
below tier 1, or if a financial or destructive one reaches Support.

## The levels

Unchanged from ADR-001. **Lower number = more privilege.**

| Tier | Label | Holds |
|---|---|---|
| 1 | Developer | Everything, derived from the catalog |
| 2 | Admin | The operational surface including money. Not `administrators.tier.set`, `files.delete`, `users.roles.manage`, or any developer tool |
| 3 | Support | Tickets, plus the read-only lookups a support conversation needs. Nothing financial, nothing destructive, no sight of the administrator directory |

Privilege nests — tier 3 ⊆ tier 2 ⊆ tier 1 — and the boot assertion enforces it.

## Also decided here

**Four-eyes is revived.** `PHASE-0:436` promised that financial actions above a threshold would need
a second administrator's approval, and the requirement then vanished from ADR-001, ADR-002 and the
blueprint. It is built, generically: a permission declares a `dualControl` spec, the endpoint answers
**202 with a pending approval** instead of executing, and a second administrator's approval performs
the write. Financial endpoints inherit it at Phase 5 by declaring a threshold predicate — no new
machinery.

Its live consumers today are the two most dangerous writes the service has: promoting anyone to
Developer, and one Developer suspending another. The second is what makes a compromised Developer
account containable at all — rule 2 protects every Developer from every other, so without a reviewed
exception there would be no way to suspend one through the API.

**Denials are recorded through one function.** `recordAuthorizationDenial()` writes a structured log
line today and is the single call site the Phase 3.5 audit writer replaces. No half-built audit
collection is created early.

**Row-level scoping exists as a primitive.** `resolveScope()` returns a descriptor a repository folds
into its query, mirroring jovi-mall's `VisibleAgentsService`. Declared for tickets (Support sees its
own queue plus unassigned); its consumer arrives at Phase 5 with the ticket module.

**An unguarded route is a boot failure.** `defineRoute()` is the only sanctioned way to register a
route and requires an `access` declaration; `assertRouteManifestComplete()` fails startup if anything
reached Express without it; and a source scan in `test-authz.ts` refuses any raw `router.get(` in a
route file. Three layers, because "remember to add the guard" does not survive 81 endpoints arriving
at Phase 5.

## Consequences

- **Phase 5 consumes a decided policy.** `legacy-endpoint-map.ts` maps all 81 legacy endpoints to
  their permission, so porting a route is mechanical rather than a per-endpoint argument.
- **Phase 6 likewise** — the nine new domains already have their permissions named, from the
  capability list in `PHASE-0:292-309`.
- **The bootstrap CLI is no longer a side door.** It refused only a second *tier-1* administrator, so
  `--tier 2` and `--tier 3` were creatable from a shell forever, bypassing every escalation rule. It
  now refuses once any administrator exists, and `--tier` is gone.
- **Authorization remains single-sided.** Per ADR-001 §6.8, jovi-mall's future
  `/api/internal/admin/*` trusts the service token and does not re-check anything. So
  `INTERNAL_ADMIN_SERVICE_TOKEN` is a full-privilege credential, and this catalog is **not** defence
  in depth for it. Recorded here rather than discovered at Phase 4.
- **A single-Developer installation cannot suspend that Developer** through the API — rule 3 needs a
  second one. Deliberate; the database is the documented break-glass path.

## Correction to the record

Every document states **82** legacy admin endpoints. The real number is **81**: the ticket router
declares 18 routes, not the 19 in `PHASE-0-DISCOVERY.md:48`. `ADR-001:54` independently says 18, and
ADR-001's own row sums come to 32 + 49 = 81 against a stated total of 82. `test-authz.ts` asserts the
count so it cannot drift again.

## Alternatives rejected

**Keep `minTier` only.** Cannot express "never rely solely on tier checks", and reproduces the
read/write conflation `PHASE-0:274` found in the legacy service.

**Put `minTier` on the permission instead of three tier lists.** Equivalent in outcome and terser to
author, but it makes "who holds what" a derived answer rather than a stated one. Three explicit lists
mean a policy review reads a policy, and the nesting assertion has something to check.

**Full RBAC as data** — the original Phase-0 design, with a runtime-editable catalog, tier grants and
per-admin overrides. Rejected for the reasons Decision 5 gave, which still hold: it re-adds three
collections, makes policy un-greppable and un-reviewable in a diff, and introduces a way to lock
every administrator out with one bad PATCH.

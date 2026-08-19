# Admin Backend — Phase 0: Repository & System Discovery

**Status:** Discovery complete. No business functionality implemented.
**Date:** 2026-08-10
**Legacy source inspected:** `backend/jovi-mall/` (Express + TypeScript + MongoDB + Redis)
**Target:** `backend/admin/` (currently empty)

Every claim below is traceable to a file path in `jovi-mall/`. Nothing here is inferred from
convention or assumed from the frontend. Where something could not be established from the
repository, it is listed in [§9 Blockers](#9-blockers--decisions-required) rather than guessed.

---

## 1. Architecture Assessment

### 1.1 What actually exists

There is **no admin backend**. There is an `admins` *module* inside the jovi-mall monolith that owns
only the admin's own profile — 7 files, one model, one repository, two endpoints.

```
jovi-mall/src/modules/admins/
├── admin.model.ts                        # IAdmin — 13 fields, no role/level/permission field
├── admin.repository.ts                   # 5 methods; recordLogin() has zero callers
├── controllers/admin-profile.controller.ts
├── dto/admin-profile.dto.ts
├── routes.ts                             # GET /profile, PATCH /profile, POST /products/bulk-vectorise
├── services/admin-profile.service.ts
└── validators/admin-profile.validator.ts
```

Everything else an administrator can do is **scattered across 10 other feature modules** as an
`admin-*.routes.ts` file sitting next to the vendor/agency/agent routers for the same domain. The
admin surface is an emergent property of the monolith, not a designed subsystem.

### 1.2 Admin endpoint census — 82 endpoints across 12 routers

| # | Router file | Mount | Endpoints |
|---|---|---|---|
| 1 | `modules/admins/routes.ts` | `/api/admin` | 3 |
| 2 | `modules/agents/routes/admin-agent.routes.ts` | `/api/admin/agents` | 11 |
| 3 | `modules/billing/routes/admin-billing.routes.ts` | `/api/admin` | 7 |
| 4 | `modules/cod/admin-cod.routes.ts` | `/api/admin/cod` | 13 |
| 5 | `modules/delivery/admin-agency.routes.ts` | `/api/admin` | 4 |
| 6 | `modules/earnings/routes/admin-earnings.routes.ts` | `/api/admin` | 2 |
| 7 | `modules/earnings/routes/admin-payout-requests.routes.ts` | `/api/admin` | 4 |
| 8 | `modules/orders/admin-order.routes.ts` | `/api/admin/orders` | 2 |
| 9 | `modules/tickets/routes/admin-ticket.routes.ts` | `/api/admin/tickets` | 19 |
| 10 | `modules/blog/routes/admin-blog.routes.ts` | `/api/admin/articles`, `/api/admin/article-authors` | 14 |
| 11 | `api/routes/file-upload.routes.ts` | `/api/files` (2 routes admin-gated inline) | 2 |
| 12 | `modules/telegram/telegram.routes.ts` | `/api/webhooks/telegram` (1 route admin-gated inline) | 1 |
| | | **Total** | **82** |

### 1.3 The `/admin` router-stacking defect

Five of these routers are mounted on the **bare `/admin` prefix** in
[`src/api/index.ts`](../../jovi-mall/src/api/index.ts) — billing, earnings, payout-requests,
delivery-agencies, and admins — in that order, with `/admin/orders`, `/admin/tickets`,
`/admin/agents`, `/admin/cod`, `/admin/articles` interleaved between them.

Each of those five routers begins with:

```ts
router.use(requireAuth);
router.use(requireRole(['admin']));
```

Express runs a sub-router's `router.use` middleware for **every request that matches the mount
prefix**, then falls through to the next router when no route matches. So a request to
`GET /api/admin/profile` — served by the *last* router mounted — passes through the `requireAuth`
of billing, earnings, payout-requests and delivery-agencies first.

**Consequence:** `requireAuth` performs a `User.findById` **plus** a role-entity `findOne` on every
invocation. `/api/admin/profile` therefore executes **~10 MongoDB queries for authentication alone**
before the handler runs. Every `/api/admin/*` path pays some multiple of this.

The codebase already knows this class of bug — `src/api/index.ts` carries a long warning comment
about four routers stacked on `/agent`, where a path collision silently made a handler unreachable.
The same hazard is live on `/admin`; today no two paths collide, but nothing prevents it and there is
no boot-time check.

### 1.4 Conventions the monolith does enforce (worth carrying forward)

These are genuinely good and should survive into the new service:

- **Uniform response envelope** — `sendSuccess` / `sendCreated` / `sendPaginated` / `sendMessage` in
  [`src/core/responses.ts`](../../jovi-mall/src/core/responses.ts). Success is
  `{ success, data, meta?, message? }`; error is
  `{ success: false, requestId, error: { code, message, statusCode, details? } }`.
- **Centralised error-code registry** — [`src/core/error-codes.ts`](../../jovi-mall/src/core/error-codes.ts),
  **506 codes** across ~41 domains, with `createAppError(code, status, message?, details?)` in
  `src/core/errors.ts`. ESLint hard-bans `throw new Error()` and `res.status().json({ error })`.
- **Central DB naming registry** — [`src/core/database/collections.ts`](../../jovi-mall/src/core/database/collections.ts)
  maps every Mongoose model name and physical collection name in one frozen object (~90 models).
- **Zod validation** at the controller boundary, snake_case in Mongo, camelCase in DTOs.
- **Request correlation ID** middleware, applied first.

---

## 2. Legacy Feature Inventory

| Feature | Exists? | Location | Behavior | Problems | Migration |
|---|---|---|---|---|---|
| **Admin self-profile** | ✅ | `modules/admins/` | `GET/PATCH /admin/profile`; returns `last_login_ip`, `two_factor_enabled`, timezone, language, job_title, department | `last_login_ip` is **always null** — `recordLogin()` has zero callers despite the model docstring claiming "Updated by auth middleware on successful login". `two_factor_enabled` is stored and returned but **never enforced anywhere** | Port; make `last_login_ip` real; either implement 2FA or drop the field |
| **Admin identity / tiers** | ❌ | — | Nothing. `IAdmin` has no level, role, permission or scope field | **The entire Level 1/2/3 model is absent.** Authorization is a single string comparison `role === 'admin'` | Build new (§7) |
| **Admin CRUD (create/list/suspend admins)** | ❌ | — | No endpoint. Admins are created only via `POST /api/auth/register` | See §4.2 — that path is publicly reachable | Build new |
| **Agent administration** | ✅ | `modules/agents/routes/admin-agent.routes.ts` | 11 endpoints: transfer between agencies, get profile+memberships, set status, tracking-allow, KYC verdict, ban, COD threshold, COD allocation, history, eligibility, tracking-policy | Well-built — the strongest admin surface in the codebase. Reason-required-on-negative-action is enforced | Preserve behavior 1:1 |
| **COD oversight** | ✅ | `modules/cod/admin-cod.routes.ts` | 13 endpoints: cash overview, remittance confirm/reject, agent deposits (incl. direct-to-platform), discrepancy resolution, trust adjustment, cash-holding agents/agencies | Confirming a remittance triggers FIFO settlement + earnings unlock — heavy invariants that must not be reimplemented elsewhere | Delegate to jovi-mall; do **not** reimplement |
| **Delivery-agency management** | ✅ | `modules/delivery/admin-agency.routes.ts` | List, get, deactivate, reactivate. Deactivation **cascades**: suspends every vendor product whose default agency is this one; reactivation restores | Only 4 endpoints — no KYC approval, no agency creation | Preserve cascade semantics; add missing verbs |
| **Vendor administration** | ❌ | — | **Nothing.** No list, no detail, no suspend, no KYC approval | `VendorRepository.setLegitVerified()` exists (`vendor.repository.ts:146`) and **has zero callers** — dead code. Same for `DeliveryAgencyRepository` (`:192`). The vendor model comments `legit_verified` as "Admin-controlled" but no admin can control it | Build new — highest-value gap |
| **Customer administration** | ❌ | — | **Nothing.** No list, no detail, no suspend | `User.status` has a `suspended` enum value that **no code path ever writes** | Build new |
| **User administration** | ❌ | — | **Nothing.** No cross-role user search, no role management, no forced logout, no password reset | Same dead `suspended` status | Build new |
| **Order administration** | ⚠️ Partial | `modules/orders/admin-order.routes.ts` | Only 2: list payment-disputed orders, manually resolve a dispute | **No order list, no order detail, no order search.** An admin cannot look up an order | Build the missing 90% |
| **Shipment administration** | ❌ | — | **Nothing.** No admin shipment list/detail/intervention | Admin can administer *agents* but not the *shipments* they carry | Build new |
| **Billing / pricing plans** | ✅ | `modules/billing/routes/admin-billing.routes.ts` | Plan CRUD (`?role=` scoped) + assign plan to vendor/agency/agent | No credit-wallet admin view, no manual credit grant, no plan-purchase history | Port; extend |
| **Earnings (platform account)** | ✅ | `modules/earnings/routes/admin-earnings.routes.ts` | Platform commission balance + ledger | Read-only; 2 endpoints | Port |
| **Payout requests** | ✅ | `modules/earnings/routes/admin-payout-requests.routes.ts` | List, get, mark-paid, reject. Backed by `PAYOUT_REQUEST` tickets | — | Port |
| **Ticketing / support** | ✅ | `modules/tickets/routes/admin-ticket.routes.ts` | 19 endpoints — full CRUD, status, assign, priority, close/reopen, followers, internal notes, attachments | The natural home of the **Level 3 Support** tier. Currently any admin has full ticket power | Port; scope by tier |
| **Blog / editorial** | ✅ | `modules/blog/routes/admin-blog.routes.ts` | 9 article + 5 author endpoints; publish/unpublish/archive/preview | Self-contained, clean | Port as-is |
| **Catalogue vectorisation** | ✅ | `modules/admins/routes.ts` → `VendorProductController.bulkVectorise` | `POST /admin/products/bulk-vectorise`, synchronous, whole-catalog capable | **Synchronous long-running job on an HTTP request.** Vectorising all products blocks a request thread until the external service answers (bulk timeout default 120 s) | Re-model as an async job with status polling |
| **File management** | ⚠️ Partial | `api/routes/file-upload.routes.ts` | 2 admin-gated routes: list orphans, hard-delete file | Guarded inline, not by a router — easy to miss during audit | Port |
| **Telegram broadcast** | ✅ | `modules/telegram/telegram.routes.ts:20` | `POST /webhooks/telegram/send` — admin-only notification send | Admin-only capability living on a **webhook path**. Misfiled | Relocate |
| **Audit log** | ❌ | `core/audit/audit-logger.ts` | **Stub.** `log()` writes `console.log`. `query()` logs "not yet implemented" and returns `[]` | Nothing is persisted. The file's own docstring promises tamper-proof append-only storage, indexing and export — none exist. **No admin action in the platform is auditable** | Build new — mandatory |
| **Admin notifications** | ❌ | `modules/notifications/` | Four stacks exist: vendor, agency, agent, customer. **No admin stack** | `collections.ts` confirms: no `ADMIN_NOTIFICATION` model | Build new |
| **System / health information** | ❌ | `app.ts:39` | `GET /api/health` → `{ status: 'ok', timestamp }`. That is the entire observability surface | No DB/Redis/worker/queue health, no version, no outbox depth | Build new |
| **Developer tools** | ❌ | — | Nothing. 15 workers start in `server.ts` with **no runtime visibility or control** | Cannot inspect or replay the tracking outbox, plan-expiry sweep, earnings release, etc. | Build new |
| **Permissions / RBAC** | ❌ | — | `requireRole(['admin'])` only | See §5 | Build new |

---

## 3. Service & Data Dependency Map

```
                      ┌──────────────────────────┐
                      │   Admin Dashboard (SPA)  │   ← user-owned, not in this repo
                      └────────────┬─────────────┘
                                   │ HTTPS
                      ┌────────────▼─────────────┐
                      │   Admin Backend (NEW)    │   ← backend/admin/  (empty today)
                      └────────────┬─────────────┘
                                   │  ??? ← the decision in §9.1
                      ┌────────────▼─────────────┐
                      │  jovi-mall (Project A)   │  Express + TS · :8022
                      │  source of truth for     │
                      │  users, orders, money    │
                      └──┬────────┬───────┬──────┘
                         │        │       │
              ┌──────────▼──┐ ┌───▼───┐ ┌─▼──────────────────┐
              │  MongoDB    │ │ Redis │ │  geo-tracker (B)   │ Go · :8090
              │ ~90 models  │ │       │ │  live GPS/routing  │
              └─────────────┘ └───────┘ └────────────────────┘
                         │
      external: Stripe · NotchPay/MyCoolPay · Firebase (storage+FCM) ·
                Cloudinary · SMTP · WhatsApp Cloud API · Telegram Bot ·
                Google Calendar · Nominatim (geocoding) · t8n vectoriser
```

**Database ownership.** One MongoDB, owned exclusively by jovi-mall. geo-tracker owns a *separate*
PostgreSQL + Redis and never touches jovi-mall's Mongo — it asks over HTTP
(`GET /api/tracking/visible-agents`, `POST /api/internal/agents/tracking-policies`) with a shared
service token, and receives HMAC-signed webhooks back. **This is the established precedent for a
second service in this platform.**

**Existing service-to-service primitive.** `src/modules/agents/middlewares/service-token.middleware.ts`
guards `/api/internal/agents/*` with `INTERNAL_SERVICE_TOKEN` and **fails closed when the secret is
unset**. A new admin backend can reuse this exact pattern rather than inventing one.

**Redis.** Single factory, `src/infra/redis/redis.factory.ts`, with logical DB separation. Used for
email-verification tokens, permission caching, and geocoding results.

**Workers.** 15 background workers/consumers start in `server.ts` (plan expiry, agency shipment cap,
4 notification consumers, file cleanup, earnings release, unpaid-order cancel, unpaid-booking cancel,
booking reminder, calendar sync, COD deposit deadline, tracking dispatch, agent capacity reconcile,
aggregation scheduler). None is observable or controllable from any API.

---

## 4. Authentication Assessment

### 4.1 How it works today

- **Algorithm:** HS256 JWT, payload `{ userId, role }`. Signed by jovi-mall's `AuthService`.
- **Transport:** `access_token` httpOnly cookie preferred; `Authorization: Bearer` fallback.
- **Refresh:** separate `refresh_token` cookie + `JWT_REFRESH_SECRET`; `requireAuth` performs a
  *silent, transparent* refresh mid-request and re-sets the cookie.
- **Resolution:** every request loads the `User` **and** the role entity from Mongo.
- **Login:** `POST /api/auth/login { identifier, password, role? }`. Same endpoint for all five roles.

### 4.2 🔴 CRITICAL — Administrator privilege escalation

Two independent paths let an attacker become a platform administrator.

**Path 1 — public self-registration as admin.**

`POST /api/auth/register` is mounted with **no auth middleware**
([`auth.routes.ts:8`](../../jovi-mall/src/modules/auth/auth.routes.ts)). Its Zod schema is:

```ts
// auth.schemas.ts:43
role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']).default('vendor'),
```

and the service honours it without any check:

```ts
// auth.service.ts:166
case 'admin':
  roleEntity = await this.adminRepo.create({
    user_id: user._id, name: input.name, email: input.email
  });
  break;
```

An unauthenticated `POST /api/auth/register { phone, name, password, role: "admin" }` creates a full
platform administrator and **returns a signed admin access token in the same response**.

**Path 2 — self-elevation via add-role.**

`POST /api/auth/add-role` requires only `requireAuth` — any authenticated user of any role. Its
schema accepts `'admin'` (`auth.schemas.ts:59`) and `AuthService.addRole` has the identical
`case 'admin'` branch (`auth.service.ts:294`), followed by `userRepo.addRoleToUser(userId, role)`.
Any customer can promote themselves.

> **This is the single most important finding in Phase 0.** It must be closed in jovi-mall
> regardless of what the new admin backend does — a new service with perfect RBAC is worthless while
> this path is open.

### 4.3 Other authentication defects

| # | Issue | Evidence | Severity |
|---|---|---|---|
| A1 | `JWT_SECRET` falls back to the literal string `'secret'` when unset | `auth.middleware.ts` — `jwt.verify(token, process.env.JWT_SECRET \|\| 'secret')`. Already recorded in `CLAUDE.md` as a known cross-service defect (geo-tracker fails closed instead) — ⚠ **superseded: that parenthesis was FALSE.** geo-tracker read `getEnv("JWT_SECRET", "secret")` too, and did so until 2026-08-19. Both sides fail closed now (Phase 3 step 3.E.2). Kept as the discovery record; see `PRODUCTION-READINESS/06-CROSS-SERVICE.md` § X-8 | 🔴 High |
| A2 | Refresh token written to stdout | `auth.middleware.ts` — `console.log('No access token — attempting silent refresh. refreshToken:', refreshToken)`. A long-lived credential in application logs | 🔴 High |
| A3 | `two_factor_enabled` is decorative | Stored in `admin.model.ts:43`, surfaced in `admin-profile.dto.ts:55`, **enforced nowhere** | 🟠 Medium |
| A4 | `last_login_ip` never populated | `AdminRepository.recordLogin()` has zero callers; docstring claims the auth middleware calls it | 🟠 Medium |
| A5 | Admin sessions have the same lifetime and rules as customer sessions | No separate policy anywhere | 🟠 Medium |
| A6 | No login throttling, lockout, or failed-attempt record | No rate-limit middleware exists in the repo | 🟠 Medium |
| A7 | `cors({ origin: true, credentials: true })` reflects **any** origin with credentials | `app.ts:27` | 🟠 Medium |
| A8 | `User.status: 'suspended'` is never written by any code path | grep across `src/` returns only the model definition | 🟠 Medium |
| A9 | Password minimum is 6 characters for every role including admin | `auth.schemas.ts` — `z.string().min(6)` | 🟡 Low |

---

## 5. Authorization Assessment

### 5.1 The whole authorization model

```ts
// api/middlewares/auth.middleware.ts
export const requireRole = (allowedRoles: string[]) => (req, res, next) => {
  if (!req.auth?.role) return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
  if (!allowedRoles.includes(req.auth.role))
    return next(createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, 'Insufficient permissions',
      { required: allowedRoles, actual: req.auth.role }));
  next();
};
```

That is the complete authorization system for administrators: **one string equality check**.

### 5.2 What this means

- **There are no admin tiers.** Every admin is omnipotent. The Level 1 / Level 2 / Level 3 model in
  the requirements has **zero** backing in the data model, the token, or the middleware.
- **There are no granular permissions.** The task brief says "use granular permissions wherever the
  existing platform supports them" — the honest answer from discovery is that **the platform supports
  none for administrators**. Every permission primitive must be built.
- **No ownership scoping.** Other roles get real scoping (a vendor sees only their own products, an
  agency only its own roster). Admin routes have none — correct in principle, but it means there is
  no existing mechanism to restrict a Support-tier admin to a subset.
- **No separation of duties.** The same admin can confirm a COD remittance, resolve the resulting
  discrepancy, and mark the payout paid, with no second signature and no audit record.
- **Reads and writes are equally privileged.** `GET /admin/cod/overview` (read) and
  `POST /admin/cod/deposits` (creates a financial record) sit behind the identical guard.
- **Two admin routes are guarded inline**, not by a router-level `use` — `/api/files/orphans` and
  `DELETE /api/files/:id/permanent`. Easy to lose track of.

### 5.3 Error semantics

`requireRole` returns `AUTH_ROLE_NOT_FOUND` with HTTP 403 for an authorization *denial*. The code
name describes a lookup failure, not a permission denial — the new service needs a proper
`AUTHZ_*` code family (`AUTHZ_PERMISSION_DENIED`, `AUTHZ_TIER_INSUFFICIENT`, …).

---

## 6. Initial Admin Capability Map

What the dashboard needs, against what exists. `⛔` = nothing exists today.

| Domain | Required capability | Backing today |
|---|---|---|
| **Users** | search across roles, detail, suspend/reinstate, force logout, reset password, role management | ⛔ none |
| **Vendors** | list/search, detail, KYC approve/reject, suspend, product oversight, settings | ⛔ none (`setLegitVerified` exists but unreachable) |
| **Agencies** | list, detail, deactivate/reactivate (cascade) | ⚠️ 4 endpoints; **no KYC approval** |
| **Agents** | detail, status, ban, KYC, tracking-allow, COD threshold, transfer, history, eligibility | ✅ 11 endpoints — port faithfully |
| **Customers** | list/search, detail, order history, suspend | ⛔ none |
| **Orders** | list/search, detail, timeline, dispute queue, manual intervention, refunds | ⚠️ dispute queue only (2 endpoints) |
| **Shipments** | list/search, detail, assignment state, manual reassign/cancel | ⛔ none |
| **COD / cash** | overview, remittances, deposits, discrepancies, trust | ✅ 13 endpoints — delegate, never duplicate |
| **Money** | platform earnings, ledger, payout queue | ✅ 6 endpoints |
| **Billing** | plan CRUD, plan assignment, credit wallets, manual grants, purchase history | ⚠️ 7 endpoints; wallets/grants missing |
| **Support** | full ticket lifecycle | ✅ 19 endpoints |
| **Content** | articles + authors | ✅ 14 endpoints |
| **Administrators** | create, list, assign tier/permissions, suspend, revoke sessions | ⛔ none — **and currently self-serve via public register** |
| **Permissions** | permission catalog, tier→permission mapping, per-admin overrides, effective-permission resolution | ⛔ none |
| **Audit logs** | immutable record of every admin action, queryable, exportable | ⛔ console-only stub |
| **Notifications** | admin inbox, alerts (disputes, discrepancies, payouts, failed webhooks) | ⛔ none (4 other roles have stacks) |
| **System info** | DB/Redis health, worker status, outbox depth, geo-tracker reachability, version | ⛔ `{ status: 'ok' }` |
| **Developer tools** | worker trigger/inspect, outbox replay, webhook redelivery, feature flags, config view | ⛔ none |

**Score: 5 of 18 domains adequately covered; 9 have nothing at all.**

---

## 7. Problems Discovered — consolidated

### 🔴 Critical

1. **Public admin self-registration** — `POST /api/auth/register { role: "admin" }` (§4.2 Path 1).
2. **Admin self-elevation** — `POST /api/auth/add-role { role: "admin" }` from any session (§4.2 Path 2).
3. **`JWT_SECRET` defaults to `'secret'`** — a deploy that forgets the env var accepts tokens anyone can forge. ✅ **Fixed** — jovi-mall's fallback was removed in the Phase-0 emergency patch; geo-tracker's equivalent `getEnv("JWT_SECRET", "secret")` survived until 2026-08-19 and is now closed too (Phase 3 step 3.E.2).
4. **No audit trail whatsoever** — `AuditLogger` is a `console.log` stub with a `query()` that returns `[]`. Financial admin actions (remittance confirmation, trust adjustment, payout mark-paid, dispute resolution) leave no record.

### 🟠 High

5. **Refresh tokens logged to stdout** (§4.3 A2).
6. **No admin tiers or permissions** — the core requirement has no foundation (§5).
7. **Admin surface has no boundary** — 82 endpoints across 12 routers in 10 modules; no single place shows what an admin can do.
8. **Auth runs up to 5× per request** on `/admin/*` due to router stacking — ~10 Mongo queries per request for auth alone (§1.3).
9. **Vendor/customer/user administration does not exist** — including approving vendor KYC, the gate on a vendor going live.
10. **Dead admin code paths** — `setLegitVerified` (vendor + agency), `recordLogin`, `two_factor_enabled`: written, documented as admin features, never wired.
11. **CORS reflects any origin with credentials** (§4.3 A7).

### 🟡 Medium

12. **Synchronous bulk vectorisation** — a whole-catalog job on an HTTP request thread.
13. **Admin-only capability on a webhook path** — `POST /api/webhooks/telegram/send`.
14. **`User.status: 'suspended'` is unreachable** — the enum value exists; nothing writes it.
15. **No admin notification stack** — the only role without one.
16. **No rate limiting anywhere** in the application.
17. **Inherited cross-service defects** (from `jovi-mall/CLAUDE.md`, verified still present): the tracking outbox is not transactional — a crash between commit and enqueue loses the event permanently.
18. **No test framework in jovi-mall** — `package.json` has 20+ `test:*` scripts, all of which are `ts-node` scripts hitting a live server, not automated tests.

---

## 8. Proposed New Architecture

### 8.1 Governing principle (inherited, and it constrains everything)

`jovi-mall/CLAUDE.md` states the platform's rule:

> **If it needs the shipment/order model, it belongs in jovi-mall.** … *ask which service would have
> to grow a copy of the other's data — that one is wrong.*

An admin backend that writes orders, shipments, COD ledgers and earnings directly into jovi-mall's
MongoDB **is** a second copy of jovi-mall's domain. Confirming a COD remittance FIFO-settles
collections and unlocks escrowed earnings; resolving a dispute moves money; deactivating an agency
cascades a suspend across every affected vendor's products. Reimplementing those invariants in a
second codebase guarantees they drift.

So the new service must own what is genuinely **its own**, and delegate what is jovi-mall's.

### 8.2 What the admin backend owns outright

Its own database. Nothing in this list exists in jovi-mall today, so nothing is being taken away:

| Owned collection | Purpose |
|---|---|
| `admin_accounts` | admin identity, tier (L1/L2/L3), status, MFA secret, lockout state |
| `admin_permissions` | the permission catalog — one row per capability |
| `admin_tier_grants` | tier → permission set (data, not hardcoded — the brief's requirement) |
| `admin_permission_overrides` | per-admin grant/revoke on top of the tier |
| `admin_sessions` | issued sessions, revocable, IP/UA bound |
| `admin_audit_log` | append-only, one row per admin action, with actor/target/before-after/result |
| `admin_notifications` | the missing fifth notification stack |
| `admin_saved_views` | dashboard/UX state |

### 8.3 What it delegates

Every mutation of platform data goes to jovi-mall over an **expanded `/api/internal/admin/*`**
service-token API, following the exact pattern already proven by geo-tracker
(`service-token.middleware.ts`, fails closed when the secret is unset). The admin backend passes the
resolved admin identity and permission verdict; jovi-mall executes its own invariants.

```
Admin Dashboard
      │  admin session cookie
      ▼
┌─────────────────────────────────────────────────────┐
│  Admin Backend                                      │
│  ┌───────────────────────────────────────────────┐  │
│  │ 1. authenticate admin (own identity + MFA)    │  │
│  │ 2. resolve effective permissions (tier+overrides) │
│  │ 3. authorize the specific operation           │  │  ← final authority
│  │ 4. write audit row (intent)                   │  │
│  │ 5. delegate ──────────────────────────────────┼──┼──► jovi-mall
│  │ 6. write audit row (outcome)                  │  │    /api/internal/admin/*
│  └───────────────────────────────────────────────┘  │    service token
│  own Mongo: admins, permissions, audit, sessions    │
└─────────────────────────────────────────────────────┘
```

**Step 4 + 6 are why the audit log finally works:** every platform mutation is funnelled through one
service that cannot forget to record it, because recording is the transport.

### 8.4 The unavoidable consequence

**This design requires new code inside jovi-mall** — an `/api/internal/admin/*` surface exposing the
operations the 82 existing admin endpoints already perform, plus the vendor/customer/user/order
administration that does not exist yet in either service.

That is not scope creep; it is where the work has to live. jovi-mall's `AdminAgencyService` already
holds the deactivation cascade, `AdminCodController.confirmRemittance` already holds FIFO settlement.
The new service should call them, not clone them.

Alternative approaches and their trade-offs are in [§9.1](#91-decision-required--data-access-model),
which is the decision I need from you before Phase 1.

### 8.5 Stack

Match jovi-mall — Express + TypeScript + MongoDB + Redis, Zod validation, the same response
envelope and error-code discipline. Reasons: it is the stack you already operate; the response
envelope is already the frontend contract; error codes can extend the existing 506-code registry
without inventing a second convention. **This is a proposal, not a discovery finding** — see §9.4.

### 8.6 Corrections carried into the new service

| Legacy problem | Correction |
|---|---|
| `role === 'admin'` boolean | Permission-checked operations; tiers are seed data mapped to permissions, resolvable per-admin |
| Console-stub audit | Append-only `admin_audit_log`, written on the delegation path so it cannot be bypassed |
| 5 routers on one prefix, 5× auth | One router tree, auth resolved once per request, permissions cached in Redis |
| `JWT_SECRET \|\| 'secret'` | Fail closed at boot: refuse to start when a required secret is unset — ⚠ the original said *"(geo-tracker's behavior)"*, which was **not true at the time**; geo-tracker was made to behave that way on 2026-08-19 |
| Tokens in logs | Structured logger with redaction; never log credential material |
| 2FA flag that does nothing | Real TOTP enrolment + enforcement, mandatory for L1 |
| No separation of duties | Financial actions above a threshold require a second admin's approval (design in Phase 1) |
| `AUTH_ROLE_NOT_FOUND` for a 403 | Dedicated `AUTHZ_*` error family |
| Synchronous bulk jobs | Job record + status polling |
| No rate limiting | Per-IP and per-account throttling, lockout on repeated failure |

---

## 9. Blockers & Decisions Required

Phase 1 cannot start until these are settled. Each is a real fork, not a formality.

### 9.1 Decision required — data access model

How does the admin backend reach platform data?

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| **A. Shared MongoDB** | Admin service connects to jovi-mall's Mongo directly | Fastest to build; no jovi-mall changes | Duplicates ~90 model definitions; **bypasses every business invariant** (FIFO settlement, escrow release, cascades); two writers, no shared code, guaranteed drift; violates the platform's own governing rule |
| **B. Delegation via internal API** ⭐ | Admin service owns identity/RBAC/audit; all platform mutations delegate to a new `/api/internal/admin/*` in jovi-mall | Single writer; invariants stay where they live; matches the proven geo-tracker precedent; audit is structurally unbypassable | Requires substantial new work **inside** jovi-mall; more moving parts |
| **C. Hybrid** | B for all writes; **read-only** direct Mongo access for lists, search, aggregation | Avoids building ~40 read endpoints in jovi-mall; keeps writes safe | Read models still drift when jovi-mall's schema changes; two connection paths to reason about |

**My recommendation: B**, with **C** as a deliberate, documented escape hatch if the read-endpoint
volume proves painful in Phase 2. B is the only option consistent with the rule the platform already
follows for geo-tracker, and it is the only one where the audit log cannot be circumvented.

**I need your call on this before anything else — it determines the entire service shape.**

### 9.2 Decision required — how the critical auth holes get closed

The register/add-role escalation (§4.2) is in **jovi-mall**, not the new service. Options:

- **(a)** I patch jovi-mall now as a standalone fix (remove `'admin'` from both Zod enums and both
  service switch branches), before any admin backend work. Small, surgical, independently shippable.
- **(b)** It is folded into the Phase 1 cutover.
- **(c)** You handle it separately.

I recommend **(a)**. It is a ~10-line change and the exposure is live today.

Related: **how is the first administrator created** once self-registration is removed? A bootstrap
CLI script, an env-seeded superadmin, or an existing-admin-invites-admin flow — the repository gives
no evidence of an intended answer.

### 9.3 Decision required — cutover strategy for the 82 existing endpoints

- **Strangler** — the new service goes live for new capabilities (users, vendors, audit, tiers) while
  the 82 legacy endpoints stay served by jovi-mall; migrate domain by domain. Dashboard talks to two
  origins during the transition.
- **Big-bang** — dashboard talks only to the admin backend from day one; every legacy endpoint is
  proxied or reimplemented before launch.

Strangler is lower-risk, but I need to know whether the dashboard can tolerate two base URLs.

### 9.4 Confirmation needed — stack

Nothing in the repository specifies a stack for a new admin service. I propose Express + TypeScript +
MongoDB + Redis (§8.5) to match jovi-mall. Confirm or override.

### 9.5 Open questions the repository could not answer

1. **What distinguishes Level 2 from Level 3 operationally?** I can propose a permission split from
   the endpoint census (e.g. Support → tickets + read-only user/order lookup; Admin → everything
   except admin management, secrets and destructive ops; Developer → all). But the actual policy is
   a business decision, and I will not invent it.
2. **Should admins be a separate identity space from platform users?** Today an admin is a `User`
   with an `Admin` role entity, and one user can hold multiple roles — a person can be a vendor
   *and* an admin. Keeping that is convenient; separating admin identity entirely is safer.
3. **Compliance retention period for the audit log?** Affects storage design and whether an archival
   tier is needed.
4. **Is there an existing Admin Dashboard frontend to inspect?** The brief mentions it; nothing in
   this workspace contains it. Memory records the frontend as user-owned. If one exists, its network
   calls are the best available evidence of intended requirements.
5. **`SUPPORT_ADMIN_USER_ID`** is an env var naming a specific admin used as the system actor for
   dispute tickets and auto-payouts (`earnings-release.worker.ts:348`, `ticket.service.ts:731`).
   Should the new service formalise this as a real "system actor" identity?

---

## 10. Proposed Implementation Phases

Phase 1 begins only after §9.1–9.4 are answered.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0** | Discovery *(this document)* | ✅ Complete |
| **0.5** | 🔴 Emergency patch in jovi-mall: close register/add-role escalation; fail closed on missing `JWT_SECRET`; stop logging refresh tokens | Escalation paths verified closed against a running server |
| **1** | Foundation: service skeleton, config with fail-closed secret validation, error-code registry, response envelope, structured logging, health endpoint, Mongo/Redis wiring. **No business endpoints.** | Service boots; health green; zero business logic |
| **2** | Admin identity & authorization: `admin_accounts`, tiers, permission catalog, tier grants, per-admin overrides, effective-permission resolution, sessions, TOTP MFA, lockout, rate limiting, bootstrap-admin path | An admin can log in; a Support-tier admin is provably denied an Admin-tier operation |
| **3** | Audit subsystem: append-only log, write-on-delegate, query + export API | Every mutation in phases 4+ produces an audit row by construction |
| **4** | Delegation transport: internal-API client, service-token auth, `/api/internal/admin/*` in jovi-mall for the **agent + COD + agency** domains (the strongest existing surfaces) | Agent/COD/agency admin operations work end-to-end through the new service, fully audited |
| **5** | Remaining legacy port: billing, earnings, payouts, orders/disputes, tickets, articles, files | All 82 legacy capabilities reachable via the admin backend |
| **6** | New capabilities: users, vendors (incl. KYC approval — wiring the dead `setLegitVerified`), customers, order list/detail/search, shipment administration | The 9 empty domains from §6 are covered |
| **7** | Operations: admin notification stack, system/health information, worker visibility, outbox inspection & replay, developer tools | Admin can observe and operate the platform |
| **8** | API documentation — `admin/api-doc/`, following jovi-mall's per-role structure. **The contract becomes the frontend's source of truth.** | Frontend can build against docs alone |

Note on ordering: audit (Phase 3) lands **before** any delegated mutation (Phase 4) deliberately —
retrofitting an audit trail onto endpoints that already work is exactly how the legacy stub happened.

---

## Appendix A — Files that matter most

| Concern | Path |
|---|---|
| Route composition, all mounts | `jovi-mall/src/api/index.ts` |
| Auth + role guard | `jovi-mall/src/api/middlewares/auth.middleware.ts` |
| Registration & escalation | `jovi-mall/src/modules/auth/auth.service.ts`, `auth.schemas.ts`, `auth.routes.ts` |
| Admin model & profile | `jovi-mall/src/modules/admins/` |
| Audit stub | `jovi-mall/src/core/audit/audit-logger.ts` |
| Error codes (506) | `jovi-mall/src/core/error-codes.ts` |
| Response envelope | `jovi-mall/src/core/responses.ts` |
| DB naming registry | `jovi-mall/src/core/database/collections.ts` |
| Service-token pattern | `jovi-mall/src/modules/agents/middlewares/service-token.middleware.ts` |
| Worker bootstrap | `jovi-mall/src/server.ts` |
| Existing admin API docs | `jovi-mall/api-doc/admin/` (13 files) |
| Cross-service contract | `backend/CLAUDE.md`, `jovi-mall/CLAUDE.md` |

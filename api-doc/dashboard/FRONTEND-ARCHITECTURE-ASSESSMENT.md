# Frontend Architecture Assessment

**Verified against source on 2026-09-08** — a dated 2026-08-13 snapshot, left as history. Its four-row reversal banner re-checked against source and found correct: the multipart route, the geo-tracker data door, `users.password.reset` now routed, and the permission count (118 across 20). The four remaining unrouted `†` names it lists were re-derived from the catalog and the route manifest and are exactly right.

**Phase 0 — discovery only. No code was written.**

> ⚠ **This is a dated snapshot, not a live reference.** Figures below were measured on
> 2026-08-13 and several have moved since — the permission count reads **110 across 21
> families** here and is **118 across 20** today. Deliberately not rewritten: it records what
> was known at Phase 0. For current numbers use [`../api/permissions.md`](../api/permissions.md)
> and [`../api/authorization.md`](../api/authorization.md).
>
> ⛔ **Four conclusions on this page have since been REVERSED, and three of them told the
> dashboard to delete something it now needs.** Checked 2026-09-08:
>
> | This page says | What is true now |
> |---|---|
> | *"wi-admin accepts no multipart bodies anywhere"* → drop `files.service.ts`, `MediaPicker`, `MediaGallery` (§ 1) | **`POST /files/upload` takes a `multipart/form-data` body**, capped at `ADMIN_UPLOAD_MAX_BYTES` (32 MiB), since BR-015 / ADR-021 on 2026-08-26. wi-admin still never *parses* one — it pipes it through unread — but the route exists and the media library is built. See [`../api/files.md`](../api/files.md) |
> | *"wi-admin has no data door into geo-tracker"* → drop `leaflet` (§ 1) | **It has one**, scoped and audited, since ADR-020 on 2026-08-22: `GET /agents/:agentId/live-position` and three siblings. See [`../api/agents.md`](../api/agents.md) |
> | *`users.password.reset` is catalogued with no route* (D6, § 8) | **Built during Phase 17.** The four permissions still without a route are `users.sessions.revoke`, `users.roles.manage`, `notifications.manage` and `developer_tools.webhooks.redeliver` |
> | *"the permission count is 110 across 21 families"* | **118 across 20.** It has moved four times; derive it, do not quote it |
>
> Every path this page writes as `docs/admin/api/…` is the pre-2026-09-08 layout. The contract
> now lives at `admin/api-doc/api/`, mirrored in the dashboard at `api-doc/admin/api/`.
Date: 2026-08-13 · Reference dashboard: `frontend/vendor-dash` · Cross-checked against `frontend/agency-dash`

Everything below was read out of the two sibling repositories and `docs/admin/`. Where a thing does
not exist, this document says so rather than describing what it would look like.

---

## 0. Starting state of this repository

| Fact | Evidence |
|---|---|
| No application code | The repo contains `CLAUDE.md` and `docs/` and nothing else — no `package.json`, no `src/`, no `index.html`, no lockfile |
| Not a git repository | No `.git` |
| No build, lint or test command exists yet | They have to be created in Phase 0 of the build |
| `docs/admin/` is a verbatim copy of `backend/admin/docs/` | Stated in `CLAUDE.md`; treat as read-only, corrections go upstream |

This document and the integration matrix are the first two files added, under `docs/dashboard/`, so
the copied bundles under `docs/admin/`, `docs/jovi-mall/` and `docs/geo-tracker/` stay untouched.

---

## 1. Existing dependencies

`vendor-dash` and `agency-dash` ship **identical dependency sets** apart from three packages. Verified
by reading both `package.json` files.

### Shared by both siblings — adopt as-is

| Concern | Package | Version |
|---|---|---|
| Framework | `react`, `react-dom` | ^19.2.0 |
| Build | `vite` | ^7.2.4 |
| React plugin | `@vitejs/plugin-react` | ^5.1.1 |
| Language | `typescript` | ~5.9.3 |
| Routing | `react-router-dom` | ^6.22.0 |
| Styling | `tailwindcss` ^3.4.19, `tailwindcss-animate`, `tw-animate-css`, `postcss` ^8.5.6, `autoprefixer` ^10.4.23 |
| Class utils | `clsx` ^2.1.1, `tailwind-merge` ^3.4.0, `class-variance-authority` ^0.7.1 |
| Primitives | 26 `@radix-ui/react-*` packages (accordion → tooltip) |
| Icons | `lucide-react` ^0.562.0 |
| Forms | `react-hook-form` ^7.70.0, `@hookform/resolvers` ^5.2.2, `zod` ^4.3.5 |
| Charts | `recharts` ^2.15.4 |
| Toasts | `sonner` ^2.0.7 |
| State | `zustand` ^4.5.0 |
| Dates | `date-fns` ^4.1.0, `react-day-picker` ^9.13.0 |
| Motion | `framer-motion` ^11.0.0 |
| Theme | `next-themes` ^0.4.6 |
| Misc UI | `cmdk`, `vaul`, `embla-carousel-react`, `input-otp` ^1.4.2, `react-resizable-panels` |
| Phone | `libphonenumber-js` ^1.13.10 |
| Lint | `eslint` ^9.39.1, `typescript-eslint` ^8.46.4, `eslint-plugin-react-hooks` ^7.0.1, `eslint-plugin-react-refresh` ^0.4.24, `globals` ^16.5.0 |
| Dev tooling | `kimi-plugin-inspect-react` ^1.0.3 (a Vite plugin, first in the plugin array in both) |
| Types | `@types/node` ^24.10.1, `@types/react` ^19.2.5, `@types/react-dom` ^19.2.3 |

**No sibling has a test runner configured.** No vitest, no jest, no playwright. Phase-gate step 3
("run available tests") is therefore a no-op unless one is added deliberately.

### Where the siblings diverge

| Package | vendor-dash | agency-dash | admin-dash |
|---|---|---|---|
| `i18next` + `react-i18next` | ✗ (hand-rolled layer) | ✓ | **✗ — port vendor-dash's layer** (decided) |
| `leaflet` + `@types/leaflet` | ✗ | ✓ (live tracking map) | **✗ — wi-admin has no geo-tracker data door** |
| `firebase` | ✓ ^10.14.1 | ✓ ^12.16.0 | **✗ — no push; the admin inbox is polled** |

### Sibling dependencies to deliberately drop

| Dropped | Why, with evidence |
|---|---|
| `firebase` + `public/firebase-messaging-sw.js` | wi-admin has **no realtime** — no WebSocket, no SSE, no push. The badge comes from polling `GET /notifications/unread-count` (`docs/admin/api/notifications.md`) |
| `leaflet` | `docs/admin/api/agents.md` — "wi-admin has no data door into geo-tracker". `tracking.lastKnown` is an explicitly stale mirror to render as "last seen", never as a live marker |
| Stripe (`VITE_STRIPE_PUBLISHABLE_KEY`) | No payment initiation anywhere on the admin surface. `/money/payments` is read-only settlement history |
| Any upload plumbing (`files.service.ts`, `MediaPicker`, `MediaGallery`) | "**No file uploads.** wi-admin accepts no multipart bodies anywhere" (`docs/admin/api/README.md`). Body limit 1 MB, JSON only |

> **File ids are opaque.** `logoFileId`, `avatarFileId`, `bannerFileId`, `deliveryProofFileId` are
> returned as bare ids and **this service resolves no file URLs** (stated on `agencies.md` and
> `agents.md`). There is no documented endpoint to turn one into an image. Recorded as a backend
> dependency in §10.

---

## 2. Existing patterns to reuse

Ranked by how directly they transfer.

| Pattern | Where it lives | Verdict |
|---|---|---|
| **Vite + `@`-alias + `tsc -b` build** | `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json` | **Copy.** `strict`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch` all on |
| **shadcn/ui config** | `components.json` — style `new-york`, base colour `slate`, CSS variables, lucide | **Copy verbatim** |
| **HSL design-token theme** | `src/index.css` + `tailwind.config.js` — `--background`, `--primary`, `--sidebar-*`, `--success/warning/info`, `darkMode: ["class"]` | **Copy.** The `success`/`warning`/`info` triad maps cleanly onto the notification severities `info`/`warning`/`critical` |
| **Nav as data, labels as translation keys** | `src/config/navigation.ts` — `NavItem { id, labelKey, icon, path, badge?, disabled?, children? }` | **Adapt.** `id` is the stable identity, `labelKey` is a compile-checked `TranslationKey`. Add a `permission` field and this becomes the permission-driven nav (§7) |
| **List cache + infinite list** | `src/lib/listCache.ts`, `src/hooks/use-infinite-list.ts` | **Reuse the cache; re-examine the hook.** The infinite hook derives page size from row height; wi-admin caps `limit` at 100 everywhere and an empty list reports `pages: 0` |
| **Responsive shell hooks** | `src/hooks/use-mobile.ts`, `use-scroll-direction.ts`, `use-scroll-restoration.ts` | **Copy** |
| **Service-per-domain modules** | `src/services/*.service.ts`, one file per backend surface, thin functions over a shared `api` | **Copy the shape** — it maps 1:1 onto wi-admin's 18 route groups |
| **Context-based store slices** | `src/store/index.tsx` — `UIState`, `OrderState`, `NotificationState` … each its own context + provider | **Adapt.** Note this is React context, **not** zustand, despite zustand being a dependency |
| **`ReasonPopover`** | `src/components/common/ReasonPopover.tsx` | **Reuse the idea heavily.** wi-admin requires a 3–500 char `reason` on ~15 writes |

### Anti-patterns not to carry over

| Do not port | Why |
|---|---|
| `LegacyAuthContext` / `LegacyRouterContext` shims in `App.tsx` | Compatibility scaffolding for pre-router components. A greenfield app has nothing to be compatible with |
| `pathToLegacyRoute()` + `LEGACY_ROUTE_MAP` | 60 lines mapping URL ↔ legacy route strings, existing only to feed the shims |
| `OnboardingGuard` / `StepGuard` / `/onboarding/*` | **Admins have no onboarding.** No `onboarding_step` exists on an administrator. An authenticated admin goes straight to the dashboard |
| snake_case wire types (`src/types/api.ts`) | jovi-mall's storage casing. **wi-admin is camelCase on the wire** and the translation never leaks |

---

## 3. Existing layout architecture

Read from `src/App.tsx`, `src/components/layout/`, `src/main.tsx`.

### Provider nesting (vendor-dash `main.tsx`)

```
<StrictMode>
  <BrowserRouter>
    <I18nProvider>          ← outermost, so login/onboarding can translate
      <StoreProvider>       ← applies the theme class to <html>
        <App />
```

### Shell composition

```
DashboardShell
├── <Sidebar/>            desktop only, 16rem expanded / 5rem icon rail
├── <Header/>             desktop only
├── <main class="px-6 py-6 md:px-8 md:py-8">
│     └── max-w-[1600px] centred, <Routes> for the section
└── <MobileTabBar/>       mobile only
```

- Collapse state lives in a `UIContext` (`sidebarCollapsed`, `toggleSidebar`, `collapsible`).
- The tablet breakpoint **force-collapses** to the icon rail and hides the toggle
  (`collapsible: !isTablet`).
- Main content gets `ml-20` / `ml-64` to clear the fixed sidebar.
- Mobile bottom padding reserves `env(safe-area-inset-bottom)`.
- Layout parts available to copy: `AppLogo`, `Header`, `Sidebar`, `MobileTabBar`,
  `MobileMoreDrawer`, `MobilePageHeader`, `MobileListFooter`, `SubPageHeader`, `PageBackButton`,
  `PlatformStatus`.

**Verdict: copy the shell, replace its contents.** It is genuinely reusable. Two additions the
admin dashboard needs that no sibling has:

1. A **tier badge** in the header (Developer / Admin / Support) — `tier` is on `/auth/me` and is
   re-read from the database on every request, so a demotion must visibly apply mid-session.
2. A **maintenance-mode banner** — `GET /system/maintenance` reports `storedMode` and
   `effectiveMode` separately and the docs say render `effectiveMode`.

### Routing conventions observed

- Everything nests under `/dashboard/*`; `/` redirects there; `*` redirects there.
- Multi-tab pages are real routes with a `:tab` param (`account/:tab`, `settings/:tab`), and the
  bare path `<Navigate>`s to the default tab. Worth keeping — the admin surface has many
  tabbed detail screens.
- `<Toaster richColors position="top-right" />` from `sonner`, mounted once at the root.

---

## 4. Existing API client

`vendor-dash/src/services/api.ts` — 416 lines. `agency-dash/src/services/api.ts` — 235 lines.

### What it does

| Capability | Implementation |
|---|---|
| Base URL | `import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8022/api'` |
| Envelope | `unwrapEnvelope<T>()` — returns `res.data` when `success` + `data` are present, else the response as-is |
| Cookies | `credentials: 'include'` on every request |
| 401 handling | Single-flight refresh with a `pendingQueue`; concurrent 401s park and replay after the refresh settles |
| Terminal 401s | `terminalAuthError()` — `AUTH_PASSWORD_CHANGED` (vendor), plus `AUTH_ACCOUNT_SUSPENDED` (agency) skip the refresh entirely and hard-logout |
| Hard logout | `POST /auth/logout` best-effort, then `window.dispatchEvent(new Event('auth:logout'))` |
| Error object | `ApiError extends Error` with `status`, `code`, `category`, `requestId`, `details`, `retryAfterSeconds`, plus predicate getters (`isUnauthorized`, `isConflict`, …) |
| `Retry-After` | Parsed from the header (numeric **or** HTTP-date), falling back to `details.retryAfterSeconds` |
| Multipart | `requestFormData()` — omits `Content-Type` so the browser sets the boundary |

### Verdict: **rebuild. Do not port.** Five load-bearing assumptions are false against wi-admin.

| # | Sibling assumption | wi-admin reality | Evidence |
|---|---|---|---|
| 1 | Refresh = `GET /auth/me` (vendor) or `POST /auth/browser/refresh` (agency) | **`POST /api/v1/auth/refresh`**, and refresh tokens **rotate on every use**. Replaying a superseded one is `ADMIN_AUTH_REFRESH_REUSED` and **destroys the whole session** | `docs/admin/api/auth.md` |
| 2 | Any 401 (bar the terminal list) is refreshable | **Three 401 codes, three remedies.** `ADMIN_AUTH_TOKEN_EXPIRED` → refresh. `ADMIN_AUTH_SESSION_REVOKED` / `ADMIN_AUTH_SESSION_EXPIRED` → sign in again. `ADMIN_AUTH_MISSING_TOKEN` → never signed in. Refreshing on the wrong one is an infinite loop | `docs/admin/api/errors.md` |
| 3 | No CSRF header is ever sent (`grep csrf` → zero hits in both) | **CSRF is required** on every cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE`: read the non-httpOnly `admin_csrf_token` cookie, echo in `X-CSRF-Token`. Mismatch = `403 ADMIN_AUTH_CSRF_INVALID` | `docs/admin/api/README.md` |
| 4 | `error.details` is an array, or one of `{violations}` / `{blockedAddresses}` / `{rowErrors}` | Those three shapes **do not exist here**. wi-admin's are `details.fields[]` (validation), `details.required` + `details.mode` (authz), `details.retryAfterSeconds` (rate limit), **`details.platformCode`** (delegated refusal), `details.status`, `details.keyValue`. And `details` is **omitted** when absent — never `null`, never `{}` | `docs/admin/api/errors.md` |
| 5 | A 2xx is a success and anything else is a failure | **`202 Accepted` is not an error** — three dual-control writes queue instead of executing and return an `Approval` object. Render "waiting for approval" | `docs/admin/api/authorization.md` |

### What the new client must add that no sibling has

- Echo `X-CSRF-Token` from the `admin_csrf_token` cookie on unsafe methods.
- Send an `X-Request-Id` and read the echoed one off the response — it is exposed via
  `Access-Control-Expose-Headers` and must be surfaced in generic error toasts.
- Refresh **only** on `ADMIN_AUTH_TOKEN_EXPIRED`; treat every other 401 as terminal.
- On any refresh failure the three cookies are cleared server-side → redirect to login, do not retry.
- Surface `202` distinctly (a discriminated result, not a thrown error).
- Carry `details.platformCode` on `PLATFORM_OPERATION_REJECTED` — it is the only handle on *why* a
  delegated write was refused, and callers must branch on it rather than on `error.code`.
- Distinguish `SERVICE_DEPENDENCY_UNAVAILABLE` (502/503, no answer came back) from a platform refusal.
- Handle the two non-enveloped responses: `GET /health/ready` (a readiness report at 503 with
  `success: false` and a `data` block, deliberately outside the error contract) and
  `GET /audit/exports/:exportId/download` (an NDJSON file body).

### What *is* worth keeping from the sibling client

The **single-flight refresh queue** (`isRefreshing` + `pendingQueue` + `flushQueue`) is exactly the
shape the contract asks for — "a request queue so N concurrent 401s trigger one refresh". Keep the
mechanism, change the trigger condition and the refresh call.

---

## 5. Existing auth implementation

**There is none to reuse. This is the single biggest gap.**

| Finding | Evidence |
|---|---|
| Neither dashboard has a login screen | `vendor-dash/src/App.tsx` `/login` renders a placeholder card with a link to `http://localhost:3000/login`. `agency-dash/src/App.tsx:59` — `const LOGIN_URL = 'http://localhost:3000/login'` |
| Neither dashboard has a login **call** | `vendor-dash/src/services/auth.service.ts` is 24 lines: `getAuthMeVendor()` and `logout()`. agency-dash adds `sendEmailVerification()` and `changePassword()`. **No `login`, no password submit, no MFA anywhere** |
| Session restoration is the only auth flow | Both call `GET /auth/auth-me/<role>` on boot and route on `role_entity.onboarding_step` |
| The `useAuth()` hook is a stub | `App.tsx` — "Legacy auth context shim… expose enough shape for Sidebar/Header (they only read user.name, user.email, user.role, user.avatar)". It is hard-coded `isAuthenticated: true` |
| No MFA, no TOTP, no QR anywhere in either repo | `input-otp` ^1.4.2 **is** a dependency in both — a 6-digit code input exists as a primitive even though nothing uses it for auth |

### Therefore Phase 2 is entirely net-new

Everything below has to be built from `docs/admin/api/auth.md` with no reference implementation:

- Login form → **three `200` success shapes**, branched on the presence of fields in `data`, never
  on the status code:
  1. ordinary — `{ admin, accessToken, refreshToken, expiresIn, csrfToken }`, cookies set;
  2. `{ mfaRequired: true, challengeId }` — **no cookies, no session**; post `challengeId` + a
     6-digit `code` to `/auth/mfa/verify` within **5 minutes**;
  3. `{ …session…, mfaEnrolmentRequired: true }` — a **real but scoped** session reaching exactly
     `/auth/me`, `/auth/logout`, `/auth/mfa/enroll`, `/auth/mfa/activate`; everything else is
     `403 ADMIN_AUTH_MFA_REQUIRED`.
- MFA enrolment — `POST /auth/mfa/enroll` returns the plaintext `secret` **exactly once**; render
  `otpauthUri` as a QR and show `secret` as the manual fallback. **A QR renderer is a new
  dependency neither sibling has** (see §10).
- `POST /auth/mfa/activate` → when `data.reauthenticationRequired` is true the scoped session is
  **ended**; route back to login.
- Login failure states: `401 ADMIN_AUTH_INVALID_CREDENTIALS` (one code for every cause, deliberately),
  `403 ADMIN_AUTH_ACCOUNT_SUSPENDED`, **`423 ADMIN_AUTH_ACCOUNT_LOCKED`** after 5 attempts for 15
  minutes, `429 RATE_LIMIT_EXCEEDED` at 10 attempts/min/IP.
- Own-session management — `GET /auth/sessions` (unpaginated, `current: true` marks this one),
  `DELETE /auth/sessions/:sessionId`, `POST /auth/logout-all`.
- Own password — `POST /auth/password`, with the **422 `ADMIN_AUTH_PASSWORD_WEAK`** policy report
  (≥12 chars, ≤200, not on the common list, not a single repeated character) rendered per rule.
- Session lifetimes to reflect in the UI: access token 900 s, idle 8 h, absolute cap 7 d.

---

## 6. Existing component system

| Aspect | Finding |
|---|---|
| Source | shadcn/ui "new-york", generated into `src/components/ui/` — **53 files** in vendor-dash |
| Inventory | accordion, alert, alert-dialog, aspect-ratio, avatar, badge, breadcrumb, button, button-group, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, empty, field, form, hover-card, info-hint, input, input-group, input-otp, item, kbd, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toggle, toggle-group, tooltip |
| Local additions | `info-hint.tsx`, `empty.tsx`, `item.tsx`, `spinner.tsx`, `button-group.tsx`, `input-group.tsx`, `field.tsx` |
| Feature components | Organised by domain — `components/{orders,products,inventory,customers,billing,tickets,…}/` |
| Convention | `components/ui/` is generated output; per `CLAUDE.md`, do not hand-edit casually |

**Verdict: copy `components/ui/` wholesale.** Every primitive the admin surface needs is present:
`table` + `pagination` for 30+ list screens, `alert-dialog` for destructive confirmations,
`input-otp` for the MFA code, `command` for a global id-search palette, `chart` (Recharts wrapper)
for the money screens, `badge` for the status vocabularies, `sheet`/`drawer` for detail panels.

Nothing needs to be added at the primitive level. The admin-specific work is at the **feature**
level: a permission gate, an approval banner, a reason-required dialog, a masked-destination
reveal, a tier badge, an audit-diff viewer.

---

## 7. Existing RBAC implementation

**There is none. In either dashboard.**

Verified by grepping both `src/` trees for `permission`, `can(`, `hasRole`, `rbac`, `authoriz`. Every
hit is unrelated:

| Hit | What it actually is |
|---|---|
| `lib/fcm.ts`, `PushPermissionBanner.tsx`, `usePushRegistration.ts` | Browser **notification** permission |
| `AddressSearch.tsx`, `useGeoTrackerSocket.ts` | Browser **geolocation** permission |
| `types/api.ts` | `PERMISSION_DENIED` as an upload-violation code |
| `i18n/locales/*/errors.ts` | Translated error strings |

The closest thing to gating is `NavItem.disabled` in `config/navigation.ts`, documented as existing
"so items can be plan-gated later by flipping a single flag". Nothing reads it dynamically.

### Therefore Phase 3 is entirely net-new, and it is the architectural centre of this dashboard

What the contract requires (`docs/admin/api/permissions.md`, `authorization.md`):

- Build navigation from **`GET /api/v1/permissions/me`** → `{ adminId, tier, tierLabel, permissions[] }`.
  Do **not** hard-code the matrix, and do **not** discover capability by collecting 403s.
- **110 permissions**, named `family.resource.action`, across 21 families. **28 are catalogued policy
  with no endpoint yet** (marked † in the matrix) — holding one does not mean a screen can exist.
- Three levels, **lower number = more privilege**: 1 Developer (110/110, MFA mandatory), 2 Admin
  (93/110, includes money), 3 Support (23/110, no financial, no sight of the administrator directory).
- Re-call `/permissions/me` after any `/auth/refresh` that follows a level change — `tier` and
  `status` are re-read from the database on **every** request.
- **Holding a permission is necessary, never sufficient.** Four layers refuse independently:
  1. permission (`403 AUTHZ_PERMISSION_DENIED`, `details.required` + `details.mode`);
  2. escalation rules on admin-on-admin actions (`AUTHZ_SELF_ACTION_FORBIDDEN`,
     `AUTHZ_TARGET_TIER_PROTECTED`, `AUTHZ_TIER_ESCALATION_FORBIDDEN`);
  3. resource scope — row-level on `audit` and `tickets`, **failing as 404, not 403**;
  4. dual control → `202`.
- **13 composite guards** need two or three permissions in `all` mode. A `<Can>` component must
  accept a list, not a single string.
- **One `any`-mode guard**: `GET /system/errors` is reachable by any of three permissions and returns
  a **different projection per level** (`view: "support" | "admin" | "developer"`). Render `view` —
  without it a Support agent cannot tell "nothing more to know" from "not being shown it".

### Composite-guard reference (all `all` mode)

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

---

## 8. Existing i18n

vendor-dash carries a **hand-rolled, compile-checked** i18n layer in `src/i18n/` — 17 modules plus
`locales/{ar,en,es,fr,pt}/` with 21 feature catalogs each, and `tools/i18n/` audit scripts.
agency-dash uses `i18next` + `react-i18next` instead.

**Decision (confirmed with the user): port vendor-dash's layer, ship `en` + `fr` only.**

### Public surface (from `src/i18n/index.ts`)

| Export | Purpose |
|---|---|
| `I18nProvider` | Holds the active locale, swaps catalogs; mounted outermost |
| `useTranslation()` → `{ t }` | Keys are **compile-checked** — a typo, or a key pointing at a namespace rather than a leaf, is a build error |
| `useFormatters()` | `currency`, `number`, `percent`, `date`, `time`, `dateTime`, `relativeTime`, `list`, `fileSize`, `country` |
| `useApiError()` / `resolveApiError` / `resolveFieldErrors` | Backend error codes → translated, user-safe messages |
| `Trans` | Sentences containing elements, so word order is not hardcoded |
| `plural({ one, other })` | `Intl.PluralRules` — never branch on `count === 1` at the call site |
| `tStatic`, `apiErrorMessage`, `getRuntimeLocale` | Module-level snapshot for stores/services, which cannot call hooks |
| `SessionLocaleSync` | Applies the session's saved language once `/auth/me` resolves |
| `LOCALES`, `SELECTABLE_LOCALES`, `resolveLocale`, `detectBrowserLocale` | Locale registry with `dir`, `intlTag`, `complete` |

### Adaptations required

| Change | Reason |
|---|---|
| Locale registry → `en`, `fr` only | Decided. Drops the `ar` RTL burden |
| Language source → `admin.preferredLanguage` | Not `role_entity.preferred_language`. It is on the profile from `/auth/me` and is settable via `PATCH /administrators/me` |
| Error catalog → rewrite entirely | The sibling catalog is keyed on jovi-mall's ~547 codes. wi-admin's registry is a different, smaller set (`ADMIN_AUTH_*`, `AUTHZ_*`, `AUDIT_*`, `DEV_TOOLS_*`, `PAYOUT_*`, `ACCOUNT_*`, `NOTIFICATION_*`) plus the **nine categories** as the generic fallback |
| Add a `platformCode` catalog | Delegated refusals carry jovi-mall's own code in `details.platformCode`; that is a second, separate message table |
| Feature catalogs → new | 21 vendor-domain catalogs (products, inventory, customers…) map onto nothing here |

### The timezone rule i18n must serve

**Date ranges are half-open `[from, to)` and date-only values are refused.** `2026-08-11` is not an
instant. The client resolves the day in **the operator's timezone** — `admin.timezone`, an IANA zone
on the profile, present for exactly this — and sends ISO-8601 instants with an explicit zone. Several
endpoints cap the span (`maxDays`: 366 on most list ranges, **92 on `GET /audit`**).

This is a formatter concern and it must be built into the shared date-range control in Phase 1, not
bolted on later.

---

## 9. Money and number formatting — one rule

**Money is a plain number in the account currency (default `XAF`), not minor units. Never divide
by 100.** The docs also describe amounts as "the minor unit", which is the same number because XAF
has no subdivision.

Signs are **not** uniform, and getting this wrong misreports money:

| Feed | Sign convention |
|---|---|
| `GET /money/earnings/platform/ledger` | `amount` is the **positive magnitude**, never signed. Direction is `entryType`'s job (`hold`, `release`, `reversal`, `reserve_hold`, `reserve_release`). A client subtracting on sign gets `reserve_hold` backwards — it moves money *sideways* |
| `GET /accounts/:t/:id/activity` | `amount` **always positive**; the sign lives in `direction` (`in`/`out`, from the owner's perspective) |
| `GET /accounts/:t/:id/credits` | `amount` is **signed** — it is a ledger and reads as one |
| `GET /accounts/:t/:id/cash-ledger` | `amount` is **signed** — positive raises the liability, negative discharges it |
| `cashMovements[]` on remittance/deposit detail | **Signed** |
| `trust-events[].delta` | **Signed**; negative is a penalty |

And three balance kinds must never be summed. Every balance object carries `unit` + `currency` +
`direction`; there is **no grand total at any level**, deliberately. `null` means "does not apply to
this owner kind", which is different from `0`.

---

## 10. Backend and tooling dependencies — things the contract does not provide

Recorded rather than mocked, per the project rule.

| # | Need | Status | Consequence |
|---|---|---|---|
| **D1** | **A dashboard home/overview endpoint** | **Does not exist.** There is no `/dashboard`, `/overview`, `/stats` or `/summary` route group anywhere in the 18 built groups | The home page must be **composed client-side** from `GET /notifications/unread-count`, `GET /approvals?status=pending`, `GET /cod/overview`, `GET /money/earnings/platform`, `GET /system/health` — each behind its own permission, each independently hideable. There is no single-call KPI payload and none should be invented |
| **D2** | **File URL resolution** | **No endpoint.** `logoFileId`, `avatarFileId`, `bannerFileId`, `deliveryProofFileId`, `store.logoFileId` are opaque ids and "this service resolves no file URLs" | Render avatars/logos as initials or placeholders. Do **not** construct a jovi-mall file URL — the dashboard calls no other service |
| **D3** | **A QR code renderer** | No sibling has one | A new frontend dependency is required for `otpauthUri` in MFA enrolment. To be chosen at Phase 2 and flagged then |
| **D4** | **Realtime** | None by design — no WebSocket, no SSE | Notifications, the approvals queue and dangling-intent counts must be **polled**. Polling intervals are a client decision the contract does not state |
| **D5** | **Support / tickets, content, files, broadcast, customers** | **Zero endpoints.** Catalogued as 28 † permissions with no route | Do not build these screens. `support.tickets.*` is 11 of the 28, and `tickets` is one of the two row-scoped resources — so Support's headline job has no surface yet |
| **D6** | **`users.roles.manage`, `users.sessions.revoke`, `users.password.reset`** | Permissions exist, **no routes** — `docs/admin/api/users.md` states why for each (jovi-mall has no role-removal code path, issues stateless JWTs with no session store, and has no admin-initiated password flow) | The user detail screen offers suspend/restore and identifier edits only |
| **D7** | **`notifications.manage`** | Catalogued, granted, **unrouted** | No global notification-source configuration screen. Per-administrator preferences are the whole surface |
| **D8** | **`developer_tools.webhooks.redeliver`** | Catalogued, **no route**, and the docs say writing one would be worse than the gap (every webhook mount is inbound) | Use `POST /dev-tools/outbox/replay` for failed outbound events |
| **D9** | **Audit export download behind a load balancer** | Documented caveat: the file lives on the instance that wrote it; multi-instance returns `410 AUDIT_EXPORT_FILE_MISSING` unless `ADMIN_AUDIT_EXPORT_DIR` is shared storage | Handle 410 with an explanatory message, not a generic failure |
| **D10** | **Purge from the dashboard** | Deliberately absent — purging lives in the CLI (`npm run audit:export -- --purge`) | The export screen must say "nothing was deleted"; show the API's own message verbatim |

---

## 11. Environment and scripts to create in Phase 0

| Item | Value | Source |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8033/api/v1` | `CLAUDE.md`; port 8033 confirmed in `docs/admin/api/README.md` |
| `VITE_APP_NAME` | e.g. `WiMall Admin` | Sibling convention |
| Dev port | **5175** (5173 vendor, 5174 agency), `strictPort: true` | Free port per `CLAUDE.md` |
| `dev` | `vite --port 5175` | agency-dash form |
| `build` | `tsc -b && vite build` | Both siblings |
| `lint` | `eslint .` | Both siblings |
| `preview` | `vite preview` | Both siblings |
| `i18n:audit` / `i18n:smoke` / `i18n:check` | Ported from `vendor-dash/tools/i18n/` | Follows the i18n decision |

**CORS note:** wi-admin uses an **exact-match origin allowlist** (`ADMIN_DASHBOARD_ORIGINS`), not a
reflector. `http://localhost:5175` has to be added there or every browser request is blocked with no
`Access-Control-Allow-Origin` header. Backend config, but a Phase 0 blocker for the first live call.

---

## 12. Assessment summary

| Layer | Verdict | Confidence |
|---|---|---|
| Build tooling & tsconfig | **Copy** | Read from both siblings |
| Design tokens & Tailwind theme | **Copy** | Read `index.css`, `tailwind.config.js` |
| `components/ui/` (53 shadcn primitives) | **Copy wholesale** | Directory listed |
| Layout shell (sidebar/header/mobile) | **Copy, then extend** with tier badge + maintenance banner | Read `App.tsx`, `components/layout/` |
| Nav-as-data config | **Adapt** — add a `permission` field | Read `config/navigation.ts` |
| Service-per-domain layout | **Copy the shape** | Read `services/` |
| i18n layer | **Port**, en+fr, new catalogs, new error tables | Read `i18n/` |
| List cache / infinite list | **Reuse cache**, re-derive paging against `limit ≤ 100` and `pages: 0` | Read `lib/listCache.ts`, `hooks/use-infinite-list.ts` |
| **API client** | **Rebuild** — 5 false assumptions | Read both `api.ts` files against `docs/admin/api/README.md` + `errors.md` |
| **Auth** | **Build from scratch** — no reference exists | Both siblings link out to `localhost:3000/login` |
| **RBAC** | **Build from scratch** — no reference exists | Grep across both `src/` trees |
| Onboarding | **Do not port** | Admins have none |
| Firebase / Leaflet / Stripe / uploads | **Drop** | No realtime, no geo door, no payments, no multipart |

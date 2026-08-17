import { PermissionName } from './permission.catalog';

/**
 * Every admin endpoint jovi-mall still serves, mapped to the permission that will guard
 * it here.
 *
 * ── What this is for ──────────────────────────────────────────────────────────
 * Phase 5 ports these. This table is the checklist it works from, so the permission for
 * each endpoint is decided once — here, with the whole surface visible — instead of
 * argued endpoint by endpoint by whoever happens to port it. Porting a route means
 * finding its row, writing the `defineRoute` call with that permission, and deleting the
 * row.
 *
 * It is a MIGRATION artifact, not a runtime one. Nothing reads it to make a decision; it
 * is deleted at cutover (Phase 8), when jovi-mall stops serving admin traffic.
 *
 * ── The count ─────────────────────────────────────────────────────────────────
 * The surface was **81**, not the 82 every document states. The tickets router has 18
 * routes, not 19: `PHASE-0-DISCOVERY.md:48` says 19, but `admin-ticket.routes.ts` declares
 * 18, and `ADR-001:54` independently says 18 while its own row sums come to 81 against a
 * stated total of 82.
 *
 * **`LEGACY_ENDPOINT_COUNT` below is the number that matters** — it is asserted by
 * `test-authz.ts`, so it cannot drift from the rows. Do not restate it in prose here: this
 * paragraph said "61 remain" for two phases after the rows said otherwise, which is
 * exactly the failure a single asserted constant exists to prevent.
 *
 * Phase 4 ported the first five — the COD remittance and deposit confirmation paths — as
 * the vertical slice that proves delegation. Phase 9 ported the delivery network: 11 agent
 * rows and 4 delivery-agency rows. Phase 10 ported orders and shipments. Phase 11 ported
 * the money: 7 billing rows, the 8 COD rows Phase 4 left, 2 platform earnings and 4 payout
 * requests. Phase 12 ported `bulk-vectorise` as the one legacy developer tool. Their
 * routes live in `src/modules/{agents,agencies,orders,shipments,billing,cod,money,dev-tools}/`,
 * and several of those surfaces gained endpoints that had no legacy row to delete because
 * they had never existed.
 *
 * `test-authz.ts` asserts the remaining count, so a row deleted without a route replacing
 * it fails the suite.
 *
 * ── `null` means no permission, not no guard ──────────────────────────────────
 * The two admin self-profile routes became `/administrators/me`, which every administrator
 * may reach by definition — `selfService`, not an ungranted permission. Those were the only
 * `null` rows and they are gone (Phase 17), so **no row uses `null` today**. The type keeps
 * it: the next self-service port needs it, and narrowing to `PermissionName` would make that
 * row unwritable rather than merely unusual.
 */

export interface LegacyEndpoint {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** The path as jovi-mall serves it today. */
    path: string;
    /** The permission that will guard it here, or null for a self-service route. */
    permission: PermissionName | null;
    /** Where it lands in this service. */
    target: string;
}

export const LEGACY_ENDPOINT_MAP: readonly LegacyEndpoint[] = [
    // ── Admin self-profile (2) — PORTED, rows deleted at Phase 17 ────────────
    // `GET`/`PATCH /api/admin/profile` became `GET`/`PATCH /administrators/me`
    // (`administrator.routes.ts:37-56`), both `selfService` — which is what `permission: null`
    // on those rows meant. They had been ported since Phase 2 and the rows outlived them,
    // which is the drift the header's own convention ("porting a route means … deleting the
    // row") exists to prevent, and the reason `LEGACY_ENDPOINT_COUNT` is asserted.
    //
    // `POST /api/admin/products/bulk-vectorise` was the third row here and is PORTED
    // (Phase 12) to `POST /api/v1/dev-tools/catalogue/vectorise`. It was the only legacy
    // endpoint that was a developer tool rather than a domain operation, and it now runs
    // through the same jovi-mall controller behind a tier-1 permission and an audit row.

    // ── Agents (11) — PORTED at Phase 9 → src/modules/agents/ ────────────────
    // Every one, plus four that never existed there: the LIST (PHASE-0 found detail-only,
    // so an administrator could not find an agent without already having their id), the
    // contract list, the contract history and the administrative activity feed. `ban`
    // became two routes here — see the router header for why.

    // ── Billing / plans (7) — PORTED at Phase 11 → src/modules/billing/ ──────
    // The catalog CRUD, plus the three `/{vendors,agencies,agents}/:id/plan` rows that
    // LOOKED like agent/agency rows and were not — they assign a subscription plan and
    // belong to the billing port, which is why they survived Phase 9's sweep.
    //
    // wi-admin collapses those three into ONE route, `POST /billing/subscriptions/
    // :ownerType/:ownerId`, and picks jovi-mall's path in its gateway. Three net-new reads
    // came with the port: a plan DETAIL (the catalog was list-only, so a plan's
    // `commission_percent` could only be seen by scanning a page), the list of subscribers
    // ON a plan, and a cross-owner subscription queue.

    // ── COD (13) — PORTED: 5 at Phase 4, the remaining 8 at Phase 11 ─────────
    // `GET /cod/agents` and `GET /cod/agencies` became ONE route there,
    // `GET /cod/holders?ownerType=`, because they answered one question about two owner
    // types. Four detail reads are net-new — the legacy surface had lists and no way to
    // open a single remittance, deposit or discrepancy.

    // ── Delivery agencies (4) — PORTED at Phase 9 → src/modules/agencies/ ────
    // All four, plus four new: search/filter on the directory, the roster, the contract
    // history and the activity feed — and `verify`, the verb the domain never had. Until
    // it, `pending_verification` had no exit except `reactivate`, an endpoint whose name
    // says the opposite and which also runs the product-restore cascade.

    // ── Platform earnings (2) + payout requests (4) — PORTED at Phase 11 → /money
    // Six rows, and six more endpoints that had no legacy row because the capability did
    // not exist: the earnings ALLOCATIONS list and detail (the collection every split is
    // computed from had no admin surface anywhere), a cross-owner balances table, gateway
    // payment and refund settlement search, and the audited destination disclosure.

    // ── Orders — PORTED (Phase 10) ───────────────────────────────────────────
    // Both endpoints now live at `/api/v1/orders/disputes` and
    // `/api/v1/orders/:orderId/dispute/resolve`, beside nine reads and three interventions
    // that had no legacy equivalent at all. The jovi-mall mount stays alive until cutover
    // (a dashboard consumes the queue), but it is dashboard surface now, not admin surface.

    // ── Tickets (18) — PORTED at Phase 17 → src/modules/support/ ────────────
    // All eighteen, plus a net-new `POST /:ticketId/claim`: claiming from the pool used
    // to be a side effect of assigning a ticket to yourself, and the tier rules make it a
    // distinct act — every tier may claim, but Support may only ever ASSIGN upward.
    //
    // This is the one family that kept NO public twin. The old mount's only admin access
    // control was the `assigned_admin_id` exclusivity lock, which is deleted, and it could
    // not have enforced the tier matrix that replaced it — a legacy `admin` is a platform
    // `users` row and carries no tier.

    // ── Blog: articles (9) + authors (5) — modules/blog/routes/admin-blog.routes.ts
    { method: 'GET', path: '/api/admin/articles', permission: 'content.articles.read', target: '/content' },
    { method: 'POST', path: '/api/admin/articles', permission: 'content.articles.write', target: '/content' },
    { method: 'GET', path: '/api/admin/articles/:id', permission: 'content.articles.read', target: '/content' },
    { method: 'GET', path: '/api/admin/articles/:id/preview', permission: 'content.articles.read', target: '/content' },
    { method: 'PATCH', path: '/api/admin/articles/:id', permission: 'content.articles.write', target: '/content' },
    { method: 'POST', path: '/api/admin/articles/:id/publish', permission: 'content.articles.publish', target: '/content' },
    { method: 'POST', path: '/api/admin/articles/:id/unpublish', permission: 'content.articles.publish', target: '/content' },
    { method: 'POST', path: '/api/admin/articles/:id/archive', permission: 'content.articles.publish', target: '/content' },
    { method: 'DELETE', path: '/api/admin/articles/:id', permission: 'content.articles.delete', target: '/content' },
    { method: 'GET', path: '/api/admin/article-authors', permission: 'content.authors.read', target: '/content' },
    { method: 'POST', path: '/api/admin/article-authors', permission: 'content.authors.write', target: '/content' },
    { method: 'GET', path: '/api/admin/article-authors/:id', permission: 'content.authors.read', target: '/content' },
    { method: 'PATCH', path: '/api/admin/article-authors/:id', permission: 'content.authors.write', target: '/content' },
    { method: 'DELETE', path: '/api/admin/article-authors/:id', permission: 'content.authors.delete', target: '/content' },

    // ── Files (2) — api/routes/file-upload.routes.ts, guarded INLINE today ───
    { method: 'GET', path: '/api/files/orphans', permission: 'files.orphans.read', target: '/files' },
    { method: 'DELETE', path: '/api/files/:id/permanent', permission: 'files.delete', target: '/files' },

    // ── Telegram broadcast (1) — modules/telegram/telegram.routes.ts ─────────
    // Admin-only capability living on a webhook path. Relocates here.
    { method: 'POST', path: '/api/webhooks/telegram/send', permission: 'broadcast.send', target: 'POST /broadcast' },
];

/** The count every document gets wrong. Asserted by `test-authz.ts`. */
export const LEGACY_ENDPOINT_COUNT = 17;

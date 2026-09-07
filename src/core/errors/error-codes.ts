/**
 * Admin service error-code registry.
 *
 * Deliberately a FRESH registry rather than a copy of jovi-mall's 506 codes: this
 * service owns a different surface, and copying codes it will never raise would make
 * the list unreadable and let the two registries drift while looking identical.
 *
 * The discipline is carried over unchanged:
 *  - domain-prefixed SCREAMING_SNAKE, value identical to key
 *  - every `createAppError` call names a code from here
 *  - `Object.freeze` so nothing mutates it at runtime
 *
 * One correction to jovi-mall's scheme is baked in from the start: it returns
 * `AUTH_ROLE_NOT_FOUND` for an authorization *denial*, a code that describes a lookup
 * failure. Authorization has its own `AUTHZ_*` family here.
 */
export const ERROR_CODES = Object.freeze({
    // ── GENERIC ───────────────────────────────────────────────────────────────
    INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

    // ── REQUEST — malformed before any schema sees it ─────────────────────────
    // Raised by Express's body parser, which rejects a request before it reaches a route.
    // Without these three the global handler had no branch for them, so a body-parser
    // failure fell through to the unknown-error case and a client sending malformed JSON
    // was told `500 INTERNAL_SERVER_ERROR — Something went wrong`: a fault reported as
    // ours, with no way for the caller to learn that their own payload was the problem.
    //
    // Distinct from VALIDATION_ERROR, which means the JSON parsed and then failed a rule.

    /** The body is not parseable JSON at all. */
    REQUEST_BODY_INVALID: 'REQUEST_BODY_INVALID',
    /** The body exceeds the 1 MB ceiling set in `app.ts`. */
    REQUEST_BODY_TOO_LARGE: 'REQUEST_BODY_TOO_LARGE',
    /** An unsupported `Content-Type` or charset. */
    REQUEST_MEDIA_TYPE_UNSUPPORTED: 'REQUEST_MEDIA_TYPE_UNSUPPORTED',

    // ── NOTIFICATIONS (Phase 13) ──────────────────────────────────────────────
    /**
     * No such notification in the caller's inbox.
     *
     * The ONLY code this surface raises, because it is the only failure it has: rows are
     * created by the projector rather than by a request, so there is no create to reject,
     * no state machine to conflict with, and no delegated call to be refused. ADR-005 D-9 —
     * a code with no thrower is a contract nobody honours.
     *
     * Also covers "exists, addressed to someone else" and "exists, but your tier no longer
     * holds the permission it is gated on". Both are 404 rather than 403 deliberately; see
     * `orNotFound` in the controller.
     */
    NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',

    // ── CONFIG / INFRA ────────────────────────────────────────────────────────
    // Raised at boot only. The process must not start holding one of these.
    CONFIG_INVALID_ENV: 'CONFIG_INVALID_ENV',
    CONFIG_MISSING_SECRET: 'CONFIG_MISSING_SECRET',
    /**
     * A notification type is declared and produced by nothing, produced twice, or gates on
     * a permission that is not catalogued. Boot-time — see `notification.coverage.ts` for
     * why this refuses to start rather than warning.
     */
    CONFIG_NOTIFICATION_COVERAGE_INCOMPLETE: 'CONFIG_NOTIFICATION_COVERAGE_INCOMPLETE',

    // A dependency this service does not own is unreachable (Mongo, Redis, jovi-mall).
    SERVICE_DEPENDENCY_UNAVAILABLE: 'SERVICE_DEPENDENCY_UNAVAILABLE',

    /**
     * jovi-mall answered a delegated operation with a 4xx — it reached the platform and
     * the platform refused it.
     *
     * Distinct from SERVICE_DEPENDENCY_UNAVAILABLE, which means we never got an answer.
     * The distinction matters to a caller: one is "your request was wrong or the state
     * moved", the other is "try again later". jovi-mall's own code travels in
     * `details.platformCode` rather than being re-mapped, because the two services keep
     * separate registries on purpose and inventing a local equivalent for 506 codes would
     * be a translation layer that drifts.
     */
    PLATFORM_OPERATION_REJECTED: 'PLATFORM_OPERATION_REJECTED',

    // ── DATABASE ──────────────────────────────────────────────────────────────
    DATABASE_UNIQUE_CONSTRAINT_VIOLATION: 'DATABASE_UNIQUE_CONSTRAINT_VIOLATION',

    // ── AUDIT (Phase 3.5) ─────────────────────────────────────────────────────
    /**
     * Boot-time only. The `wi-admin` database is not a replica set or a mongos, so
     * multi-document transactions are unavailable — and an audited write is a state
     * change and its audit row committing together. Without transactions the service
     * could still start and would silently degrade to "audited, probably", which is the
     * one guarantee this subsystem exists to make. It fails closed instead.
     */
    AUDIT_STORE_NOT_TRANSACTIONAL: 'AUDIT_STORE_NOT_TRANSACTIONAL',

    /** The action registry names a permission, target or family that does not exist. Boot-time. */
    AUDIT_CATALOG_INVALID: 'AUDIT_CATALOG_INVALID',

    /**
     * A mutating route records nothing, names an action the catalog does not know, or claims
     * an action its own permission does not govern — OR a catalogued action has no producer
     * at all. Boot-time.
     *
     * The last case is the one that earns this code: `approvals.*` and `audit.export` were
     * declared and written by nothing for two phases. `AUDIT_CATALOG_INVALID` is about the
     * catalog being internally malformed; this is about the catalog and the code disagreeing.
     */
    AUDIT_COVERAGE_INCOMPLETE: 'AUDIT_COVERAGE_INCOMPLETE',

    AUDIT_ENTRY_NOT_FOUND: 'AUDIT_ENTRY_NOT_FOUND',
    AUDIT_EXPORT_NOT_FOUND: 'AUDIT_EXPORT_NOT_FOUND',
    // `AUDIT_LEGACY_FEED_DISABLED` was here — the 404 `GET /audit/legacy` answered when its
    // feature flag was off. Deleted at Phase 5 Part D with the route, the module and the flag.

    /** The requested range exceeds `ADMIN_AUDIT_EXPORT_API_MAX_ROWS` — narrow it, or use the CLI. */
    AUDIT_EXPORT_TOO_LARGE: 'AUDIT_EXPORT_TOO_LARGE',
    /** The export did not finish, so its file is not durable and nothing it covers may be purged. */
    AUDIT_EXPORT_INCOMPLETE: 'AUDIT_EXPORT_INCOMPLETE',
    AUDIT_EXPORT_FILE_MISSING: 'AUDIT_EXPORT_FILE_MISSING',

    // ── SYSTEM / DEVELOPER TOOLS (Phase 12) ───────────────────────────────────

    /** `EXPOSED_CONFIG_KEYS` names something credential-shaped. Boot-time. */
    SYSTEM_CONFIG_EXPOSURE_UNSAFE: 'SYSTEM_CONFIG_EXPOSURE_UNSAFE',

    /** The feature-flag registry is malformed — a flag with no consumer, say. Boot-time. */
    SYSTEM_FEATURE_FLAG_CATALOG_INVALID: 'SYSTEM_FEATURE_FLAG_CATALOG_INVALID',

    /**
     * The `dev_tools.enabled` flag is off.
     *
     * 409 rather than 403: the caller holds the permission, and the service is refusing
     * right now. A 403 would send an administrator to look at their own grants, which is
     * the wrong place.
     */
    DEV_TOOLS_DISABLED: 'DEV_TOOLS_DISABLED',

    /**
     * A Support-tier error query with no reference and no bounded window (Phase 16).
     *
     * 400 rather than 403: the caller holds the permission and the request is simply too
     * broad. A 403 would send them to look at their own grants, which is the wrong place —
     * the remedy is to add a requestId or a code plus a since.
     *
     * The narrowing is not about the projection being unsafe. Even the Support view names a
     * route group, a role and a timestamp per failure, and an open scroll of those is a
     * reconnaissance feed however little each row says.
     */
    SYSTEM_ERROR_QUERY_TOO_BROAD: 'SYSTEM_ERROR_QUERY_TOO_BROAD',

    /** That worker key is not in jovi-mall's registry. */
    DEV_TOOLS_WORKER_UNKNOWN: 'DEV_TOOLS_WORKER_UNKNOWN',

    /**
     * That worker is already running.
     *
     * 409 rather than a queue: these run against live data, and two concurrent passes of a
     * sweep is precisely what the mutex exists to prevent.
     */
    DEV_TOOLS_WORKER_BUSY: 'DEV_TOOLS_WORKER_BUSY',

    // ── AUTHZ (authorization — may you) ───────────────────────────────────────
    // The split between "who are you" (ADMIN_AUTH_*) and "may you" (AUTHZ_*) was
    // reserved in Phase 1 and is populated here. jovi-mall conflates them, returning
    // AUTH_ROLE_NOT_FOUND — a lookup-failure code — for a 403.
    //
    // A 403 from this family carries `details.required` (the permission name) but NEVER
    // what the caller holds. Echoing the caller's own tier or permission set back to them
    // is jovi-mall's `{ required, actual }` leak; the required name alone is enough to
    // debug, and any authenticated admin can read the catalog anyway.

    /** The caller's tier does not grant the permission this route declares. */
    AUTHZ_PERMISSION_DENIED: 'AUTHZ_PERMISSION_DENIED',
    /** Reserved for a bare tier floor. The permission guard is the normal path. */
    AUTHZ_TIER_INSUFFICIENT: 'AUTHZ_TIER_INSUFFICIENT',

    // ── AUTHZ — administrator-on-administrator (privilege escalation) ──────────
    // Holding `administrators.*` is necessary, never sufficient. These three are the
    // resource-level rules that sit behind the permission check, and they are the
    // difference between "an Admin may manage administrators" and "an Admin may promote
    // themselves to Developer".

    /** Suspending, demoting or resetting YOURSELF. Refused whatever you hold. */
    AUTHZ_SELF_ACTION_FORBIDDEN: 'AUTHZ_SELF_ACTION_FORBIDDEN',
    /** The target is at or above the actor's own level. Lower tier number = more privilege. */
    AUTHZ_TARGET_TIER_PROTECTED: 'AUTHZ_TARGET_TIER_PROTECTED',
    /** Assigning a tier at or above the actor's own — minting a peer or a superior. */
    AUTHZ_TIER_ESCALATION_FORBIDDEN: 'AUTHZ_TIER_ESCALATION_FORBIDDEN',

    // ── AUTHZ — dual control (four-eyes) ──────────────────────────────────────
    // A high-privilege action is not denied, it is QUEUED: the endpoint answers 202 with
    // an approval id, and a second administrator commits it. AUTHZ_APPROVAL_REQUIRED is
    // therefore not returned on the happy path — it exists for a caller that reaches the
    // execution path without one.
    AUTHZ_APPROVAL_REQUIRED: 'AUTHZ_APPROVAL_REQUIRED',
    AUTHZ_APPROVAL_NOT_FOUND: 'AUTHZ_APPROVAL_NOT_FOUND',
    /** The requester tried to approve their own request. The entire point is that they cannot. */
    AUTHZ_APPROVAL_SELF_APPROVAL: 'AUTHZ_APPROVAL_SELF_APPROVAL',
    AUTHZ_APPROVAL_EXPIRED: 'AUTHZ_APPROVAL_EXPIRED',
    AUTHZ_APPROVAL_ALREADY_RESOLVED: 'AUTHZ_APPROVAL_ALREADY_RESOLVED',

    // ── AUTHZ — boot-time policy failures ─────────────────────────────────────
    // Both are 500s raised before the server listens. The process must not start holding
    // one: a service with an inconsistent grant table or an unguarded route is worse than
    // a service that is down, because it looks like it is working.

    /** A route reached the router without declaring who may call it. */
    AUTHZ_ROUTE_UNDECLARED: 'AUTHZ_ROUTE_UNDECLARED',
    /** The tier→permission table names an unknown permission, or leaves one ungranted. */
    AUTHZ_GRANT_TABLE_INVALID: 'AUTHZ_GRANT_TABLE_INVALID',

    // ── ADMIN AUTH (authentication — who is calling) ──────────────────────────
    /**
     * The ONLY code returned for a failed credential check, whatever the cause:
     * unknown email, wrong password, or an account that cannot log in. Splitting it
     * turns the login form into an account-existence oracle.
     */
    ADMIN_AUTH_INVALID_CREDENTIALS: 'ADMIN_AUTH_INVALID_CREDENTIALS',
    /**
     * The deliberate exception to the rule above. Telling a locked-out admin to wait
     * is worth confirming the account exists — otherwise they keep retrying and keep
     * extending their own lockout.
     */
    ADMIN_AUTH_ACCOUNT_LOCKED: 'ADMIN_AUTH_ACCOUNT_LOCKED',
    ADMIN_AUTH_ACCOUNT_SUSPENDED: 'ADMIN_AUTH_ACCOUNT_SUSPENDED',
    ADMIN_AUTH_MISSING_TOKEN: 'ADMIN_AUTH_MISSING_TOKEN',
    ADMIN_AUTH_TOKEN_INVALID: 'ADMIN_AUTH_TOKEN_INVALID',
    ADMIN_AUTH_TOKEN_EXPIRED: 'ADMIN_AUTH_TOKEN_EXPIRED',
    /** The signature verified but the session is gone — logged out, revoked, or idle-expired. */
    ADMIN_AUTH_SESSION_REVOKED: 'ADMIN_AUTH_SESSION_REVOKED',
    ADMIN_AUTH_SESSION_EXPIRED: 'ADMIN_AUTH_SESSION_EXPIRED',
    /** A superseded refresh token was presented — it leaked. The whole session is destroyed. */
    ADMIN_AUTH_REFRESH_REUSED: 'ADMIN_AUTH_REFRESH_REUSED',
    ADMIN_AUTH_MFA_REQUIRED: 'ADMIN_AUTH_MFA_REQUIRED',
    ADMIN_AUTH_MFA_INVALID: 'ADMIN_AUTH_MFA_INVALID',
    ADMIN_AUTH_MFA_ALREADY_ENROLLED: 'ADMIN_AUTH_MFA_ALREADY_ENROLLED',
    ADMIN_AUTH_MFA_NOT_ENROLLED: 'ADMIN_AUTH_MFA_NOT_ENROLLED',
    ADMIN_AUTH_CSRF_INVALID: 'ADMIN_AUTH_CSRF_INVALID',
    ADMIN_AUTH_PASSWORD_WEAK: 'ADMIN_AUTH_PASSWORD_WEAK',

    // ── LIVE TRACKING (Phase 6.I · ADR-020) ───────────────────────────────────
    //
    // The three ways a live-tracking read fails that are not this service's own 4xx.
    // They are separate codes rather than one because the remedies are different people:
    // the first is an operator's deployment, the second is geo-tracker's scope
    // configuration, and the third is somebody's pager.

    /**
     * `GEO_TRACKER_DATA_BASE_URL` / `GEO_TRACKER_ADMIN_TOKEN` are unset, so this deployment
     * has no data door at all — a supported posture, and the default.
     *
     * A 503 rather than a 404: the routes exist and the capability is built. Telling a
     * dashboard "no such endpoint" would send somebody to look for a missing deploy.
     */
    TRACKING_DOOR_UNCONFIGURED: 'TRACKING_DOOR_UNCONFIGURED',

    /**
     * geo-tracker refused the read. `details.upstreamCode` carries its code verbatim —
     * `SERVICE_SCOPE_FORBIDDEN` (this credential does not hold the scope, with
     * `details.scope` naming it), `SERVICE_TOKEN_INVALID` (the shared secret has drifted),
     * `SERVICE_DOOR_NOT_CONFIGURED` (geo-tracker's half is closed).
     *
     * Passed through rather than collapsed because each of those is a one-line fix by a
     * different person, and a generic "tracking unavailable" makes all three look like an
     * outage.
     */
    TRACKING_DOOR_REFUSED: 'TRACKING_DOOR_REFUSED',

    /** geo-tracker could not be reached, or did not answer in time. Retry; report nothing. */
    TRACKING_DOOR_UNAVAILABLE: 'TRACKING_DOOR_UNAVAILABLE',

    // ── AUTOMATION FAILURE REPORTS (ADR-022) ──────────────────────────────────
    //
    // The inbound half — the first credentialed non-administrator caller this service has.
    // Both are returned to n8n, never to a dashboard, so their audience is an operator
    // reading a reporter node's response body rather than a person.

    /**
     * The shared secret is missing, malformed or wrong.
     *
     * One code for all three, the `ADMIN_AUTH_INVALID_CREDENTIALS` reasoning applied to a
     * service caller: splitting "no header" from "wrong value" tells an unauthenticated
     * prober which half of the credential it got right.
     */
    AUTOMATION_REPORT_TOKEN_INVALID: 'AUTOMATION_REPORT_TOKEN_INVALID',

    /**
     * The body is not a failure report this service can store.
     *
     * Distinct from the token code because the remedies are different people: that one is
     * an operator's env var, this one is the reporter workflow's node parameters.
     */
    AUTOMATION_REPORT_MALFORMED: 'AUTOMATION_REPORT_MALFORMED',

    /**
     * The door is closed — `AUTOMATION_REPORT_TOKEN` is unset, so this deployment accepts
     * no failure reports.
     *
     * A 503 rather than a 404, for the reason `TRACKING_DOOR_UNCONFIGURED` gives: the route
     * exists and the capability is built, and answering "no such endpoint" would send
     * somebody looking for a missing deploy.
     */
    AUTOMATION_DOOR_UNCONFIGURED: 'AUTOMATION_DOOR_UNCONFIGURED',

    // ── MONEY / ACCOUNTS (Phase 11) ───────────────────────────────────────────

    /**
     * The payout exists; it carries no destination to reveal.
     *
     * Distinct from `NOT_FOUND` on purpose. A dashboard has to tell "no such payout" from
     * "this payout predates the destination snapshot" — the first is a broken link, the
     * second is a legacy row an operator has to resolve by asking the beneficiary. Folding
     * both into a 404 makes the second look like the first and sends someone hunting for a
     * record that is right in front of them.
     */
    PAYOUT_DESTINATION_ABSENT: 'PAYOUT_DESTINATION_ABSENT',

    /**
     * `:ownerType/:ownerId` names nobody — no such vendor, agency or agent.
     *
     * Separate from a missing BALANCE, which is not an error at all: an owner who has
     * never been allocated anything has no `earnings_accounts` row, and the account view
     * reports zeroes rather than 404ing. Only the owner itself being absent is a 404.
     */
    ACCOUNT_OWNER_NOT_FOUND: 'ACCOUNT_OWNER_NOT_FOUND',

    /**
     * The payout is no longer `pending`, so it can be neither paid nor rejected.
     *
     * jovi-mall answers `EARNINGS_PAYOUT_REQUEST_NOT_PENDING` for the same situation and
     * that code reaches the dashboard in `details.platformCode` whenever the delegated call
     * is actually made. This one exists for the two moments where **no call is made and
     * there is therefore no platform code to inherit**:
     *
     *   - the pre-flight refusal on `mark-paid`, which must not queue an approval for an
     *     action that is already impossible. Queueing it would put a request in front of a
     *     second administrator that cannot succeed however they decide.
     *   - the dual-control handler's re-check. An approval may sit for `ADMIN_APPROVAL_TTL_S`,
     *     and a payout resolved in the meantime must be refused rather than paid twice.
     */
    PAYOUT_NOT_PENDING: 'PAYOUT_NOT_PENDING',

    // ── ADMIN ACCOUNT ─────────────────────────────────────────────────────────
    ADMIN_ACCOUNT_NOT_FOUND: 'ADMIN_ACCOUNT_NOT_FOUND',
    ADMIN_SESSION_NOT_FOUND: 'ADMIN_SESSION_NOT_FOUND',
    /**
     * Distinct from DATABASE_UNIQUE_CONSTRAINT_VIOLATION on purpose. Creating an
     * administrator is an authenticated, authorized act by another administrator, so
     * naming the collision is useful rather than an existence oracle — unlike the login
     * form, where every failure shares one code.
     */
    ADMIN_ACCOUNT_ALREADY_EXISTS: 'ADMIN_ACCOUNT_ALREADY_EXISTS',

    // ── CONTRACTS ─────────────────────────────────────────────────────────────

    /**
     * No such agent↔agency contract.
     *
     * Its own code rather than a bare `NOT_FOUND` because `GET /contracts/:contractId` is
     * addressable by id and the id is what people paste into tickets — a client showing
     * "not found" needs to say WHAT was not found, and the surrounding 404s on that screen
     * are about agents and agencies.
     */
    CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',

    // ── SUPPORT ───────────────────────────────────────────────────────────────

    /**
     * No such ticket — **or one outside the caller's tier scope**, deliberately
     * indistinguishable.
     *
     * That conflation is the security property, not a shortcut. The ticket scope is folded
     * into the query (`resource-scope.ts:20-29`), so a Support administrator asking for an
     * Admin's ticket gets the same answer as one asking for an id that never existed. A 403
     * would confirm the record exists, which is exactly what somebody probing another tier's
     * queue wants to learn.
     *
     * Contrast `AUTHZ_PERMISSION_DENIED` on the same surface: that IS raised, for a ticket
     * the caller can already see but may not act on. Concealing at that point protects
     * nothing they do not already know.
     */
    TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',

    /** The ticket is already held by an administrator, so there is nothing to claim. */
    TICKET_ALREADY_ASSIGNED: 'TICKET_ALREADY_ASSIGNED',

    // ── FILES ─────────────────────────────────────────────────────────────────

    /**
     * A file id resolved to nothing.
     *
     * ⚠ Reachable on a perfectly ordinary path and NOT a client bug: files are
     * soft-deleted and swept by file-cleanup, so a record can outlive the picture it
     * references. A client should render the absence, not an error banner. The batch form
     * omits unresolvable ids rather than raising; only the single-id route answers this.
     */
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',

    /**
     * The hard delete's body did not repeat the id in its path.
     *
     * The `outbox.prune` precedent (Phase 5 D-9): make the operator restate the value that
     * decides the blast radius. There it is the retention age; here it is the file id, because
     * a file id is the whole of what this operation acts on and the operation cannot be undone.
     * Raised at 400 — it is a body that failed a rule, not a state that moved.
     */
    FILE_DELETE_NOT_CONFIRMED: 'FILE_DELETE_NOT_CONFIRMED',

    /**
     * The deployment's storage provider cannot serve file contents at all (BR-011).
     *
     * ⚠ **A CONFIGURATION state, not an outage, and the two must be distinguishable** —
     * that is the entire reason this is its own code rather than a
     * `SERVICE_DEPENDENCY_UNAVAILABLE`. jovi-mall's `getDownloadStream` is implemented on
     * the `local` provider and throws on `firebase` and `cloudinary`, so on those
     * deployments the answer is a permanent "this platform cannot show private files"
     * rather than "try again". A client that cannot tell them apart either shows a retry
     * button that will never work, or sends an operator hunting an incident that is not
     * happening.
     *
     * Raised at **409**, so the derived category is `business_rule` and the message
     * survives the boundary filter — an `external_service` 5xx would have its message
     * replaced by the registry default and its `details` dropped, losing the provider
     * name that says *why*.
     *
     * Arrives from jovi-mall as `details.platformCode = 'STORAGE_DOWNLOAD_NOT_SUPPORTED'`
     * on a `PLATFORM_OPERATION_REJECTED`, and is re-raised under this name by the file
     * gateway. Branch on `error.code`.
     */
    FILE_CONTENT_NOT_SUPPORTED: 'FILE_CONTENT_NOT_SUPPORTED',

    /**
     * `POST /files/upload` was sent something that is not `multipart/form-data` (BR-015).
     *
     * ⚠ **This is the one refusal on the upload route that no schema could express**, and
     * it is why it is a code rather than a `VALIDATION_ERROR`. This service does not PARSE
     * multipart (ADR-021 D-2) — the body is piped to jovi-mall unread — so there is no
     * parsed body for Zod to validate and nothing to report a field path against. What can
     * be checked is the `Content-Type`, and it must be, because the failure it prevents is
     * silent: a JSON body forwarded to jovi-mall's multer produces "no files uploaded" from
     * a service the caller never addressed, with jovi-mall's vocabulary and none of the
     * context.
     *
     * Raised at **415**, the status that names the cause. A 400 would be indistinguishable
     * from the body being malformed, which is a different fix.
     */
    FILE_UPLOAD_NOT_MULTIPART: 'FILE_UPLOAD_NOT_MULTIPART',

    /**
     * The upload body exceeds **this service's** declared ceiling (`ADMIN_UPLOAD_MAX_BYTES`).
     *
     * ⚠ **Not jovi-mall's limit, and the difference is the point.** jovi-mall sizes its
     * per-request ceiling by ROLE and an administrator's figure there is 2 GB — a number
     * chosen for a surface an administrator no longer reaches. wi-admin declares its own,
     * sized for what an administrator actually uploads (blog imagery, ticket attachments),
     * and refuses BEFORE the hop so a doomed 2 GB body is never streamed across it.
     *
     * Enforced twice, deliberately: on `Content-Length` when the client sends one, and on
     * the bytes as they flow when it does not. A chunked upload has no length to check, and
     * a ceiling that only reads a header is a ceiling any client can decline to declare.
     *
     * `details` carries `maxBytes` so a client can render the limit rather than restate a
     * constant that may drift. Raised at **413**.
     */
    FILE_UPLOAD_TOO_LARGE: 'FILE_UPLOAD_TOO_LARGE',

    // ── CONTENT / EDITORIAL ───────────────────────────────────────────────────
    //
    // The `BLOG_` prefix is jovi-mall's, and it is kept deliberately. Ownership of
    // `articles` and `article_authors` moved here at Phase 5 Part A (ADR-004 D-4), but
    // jovi-mall's public reader still raises `BLOG_ARTICLE_MOVED` and `BLOG_ARTICLE_GONE`
    // on the same records, and its `api-doc/public/articles.md` publishes them. Renaming
    // this half to `CONTENT_*` would give one collection two error vocabularies split by
    // which service answered — so the editor's codes keep the names they had, and a client
    // that already handles them keeps working across the cutover.
    //
    // The two public codes are NOT here: nothing on this surface serves a reader.

    /** No such article. Also raised for one that is soft-deleted. */
    BLOG_ARTICLE_NOT_FOUND: 'BLOG_ARTICLE_NOT_FOUND',

    /** The stable id is taken. Ids are permanent by contract, so this is not retryable. */
    BLOG_ARTICLE_KEY_TAKEN: 'BLOG_ARTICLE_KEY_TAKEN',

    /**
     * Publishing was refused, and `details.blockers` says why — as a **checklist**, not a
     * first failure. Telling an editor about one missing piece at a time, over three
     * round-trips, is how a publish button earns a reputation for being broken.
     */
    BLOG_ARTICLE_NOT_PUBLISHABLE: 'BLOG_ARTICLE_NOT_PUBLISHABLE',

    /** Already live. Publishing twice would be a no-op that looks like a state change. */
    BLOG_ARTICLE_ALREADY_PUBLISHED: 'BLOG_ARTICLE_ALREADY_PUBLISHED',

    /**
     * Refused because the article has been published before — `published_at` is the test,
     * not `status`, because an already-unpublished article was still live once.
     *
     * ⚠ Not a permission problem and not retryable. Once an address has been live it may
     * have inbound links, and a 404 wastes them. The remedy is `archive`, which keeps the
     * URL answering `410 Gone` with its category hub.
     */
    BLOG_ARTICLE_DELETE_NOT_ALLOWED: 'BLOG_ARTICLE_DELETE_NOT_ALLOWED',

    /**
     * Another article answers to this `(locale, slug)` — **including as a RETIRED slug**.
     * A reused slug turns a permanent redirect into a wrong answer, which is worse than
     * the 404 it was avoiding.
     */
    BLOG_SLUG_TAKEN: 'BLOG_SLUG_TAKEN',

    /** `category`, `page` or `index` — each collides with a route rather than resolving. */
    BLOG_SLUG_RESERVED: 'BLOG_SLUG_RESERVED',

    BLOG_AUTHOR_NOT_FOUND: 'BLOG_AUTHOR_NOT_FOUND',
    BLOG_AUTHOR_KEY_TAKEN: 'BLOG_AUTHOR_KEY_TAKEN',

    /**
     * The byline is credited on at least one article. `details.articleCount` says how many.
     *
     * This refusal is what makes `author` non-null on every published article: the public
     * DTO resolves the byline by key, and a dangling reference would put an article
     * carrying `BlogPosting` structured data on the site with no author node at all.
     */
    BLOG_AUTHOR_IN_USE: 'BLOG_AUTHOR_IN_USE',

    // ── CREDENTIAL RECOVERY ───────────────────────────────────────────────────
    //
    // All three arrive from jovi-mall as `details.platformCode` on a
    // `PLATFORM_OPERATION_REJECTED`, since the send is delegated. They are catalogued
    // here because the dashboard branches on them to say WHY rather than showing a
    // generic failure, and `errors.md` is the file its i18n suite diffs against.

    /** The party has no address on the requested channel. */
    USER_CHANNEL_UNAVAILABLE: 'USER_CHANNEL_UNAVAILABLE',
    /**
     * Too many links, recently. `details.scope` is `party` or `administrator` — the two
     * have different remedies (wait, versus ask a colleague), so the distinction has to
     * survive to the screen. `details.retryAfterSeconds` carries the wait.
     */
    USER_CREDENTIAL_LINK_THROTTLED: 'USER_CREDENTIAL_LINK_THROTTLED',
    /**
     * A sign-in link was asked for on an account that is not a customer.
     *
     * The refusal is jovi-mall's and it is structural rather than configurable: every
     * session `MessagingLoginService` mints is scoped to `customer` as a literal, because
     * a vendor, agency or agent reaches money and other people's data.
     */
    USER_LOGIN_LINK_ROLE_UNSUPPORTED: 'USER_LOGIN_LINK_ROLE_UNSUPPORTED',
} as const);

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

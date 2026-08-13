# `/vendors` — vendor management

Base path: `/api/v1/vendors`

The directory, the detail, the catalogue as oversight sees it, business verification,
suspension, per-product takedown, and the platform-governed order settings.

Design record: [`../ADR-008-VENDOR-MANAGEMENT.md`](../ADR-008-VENDOR-MANAGEMENT.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/vendors` | `vendors.read` | direct read | — |
| `GET` | `/vendors/:vendorId` | `vendors.read` | direct read | — |
| `GET` | `/vendors/:vendorId/products` | `vendors.read` | direct read | — |
| `GET` | `/vendors/:vendorId/activity` | `vendors.read` **+** `audit.read` | direct read | — |
| `POST` | `/vendors/:vendorId/suspend` | `vendors.suspend` | **delegated** | ✅ |
| `POST` | `/vendors/:vendorId/restore` | `vendors.suspend` | **delegated** | ✅ |
| `POST` | `/vendors/:vendorId/kyc/approve` | `vendors.kyc.review` | **delegated** | ✅ |
| `POST` | `/vendors/:vendorId/kyc/reject` | `vendors.kyc.review` | **delegated** | ✅ |
| `POST` | `/vendors/:vendorId/products/:productId/suspend` | `vendors.products.manage` | **delegated** | ✅ |
| `POST` | `/vendors/:vendorId/products/:productId/restore` | `vendors.products.manage` | **delegated** | ✅ |
| `PATCH` | `/vendors/:vendorId/settings` | `vendors.settings.manage` | **delegated** | ✅ |

`vendors.read` is a Support-level lookup. The seven writes are **Admin and above**, and are
split across **four** permissions on purpose: suspension, verification, product oversight and
settings are four different jobs with four different blast radii — a KYC reviewer should not be
able to take a shop offline.

## Three status axes, and they are not the same thing

A vendor screen shows three independent states. Confusing them is the commonest mistake here.

| Axis | Field | Means |
|---|---|---|
| **Vendor status** | `status` | May the shop trade? `active` / `pending_verification` / `inactive` |
| **Account status** | `account.status` | May the person sign in at all? `active` / `suspended` — see [users.md](users.md) |
| **Shop open** | `store.isOpen` | The vendor's **own** vacation switch. Not an admin action |

Suspending one does not touch the others.

Status values are jovi-mall's own, verbatim — `inactive`, not a friendlier `suspended`. A wire
vocabulary that disagrees with the column is a translation table somebody has to maintain in
both directions, and `inactive` is what an operator will see when they check the database behind
a screen that surprised them.

## What this surface deliberately does not offer

| Missing | Why |
|---|---|
| Billing, earnings, payouts | They sit behind `billing.*` and `money.*` and have their own surfaces. The detail carries the ids; the dashboard composes those panels from [billing.md](billing.md), [money.md](money.md) and [accounts.md](accounts.md) |
| **Per-vendor commission** | It lives on the billing `PricingPlan`, set by assigning a plan. `vendors.settings.manage` governs order settings, not the rate. Do not extend it there |
| Editing the vendor's profile | Their business name, addresses, policies and payout destinations are theirs. An administrator suspends, verifies and oversees; they do not act as the vendor |
| A catalogue search **across** vendors | This is a per-vendor view, scoped by the path. A cross-vendor catalogue is a different surface with a different permission |

---

## `GET /vendors`

The directory.

| | |
|---|---|
| **Permission** | `vendors.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `updatedAt`, `email`. Default **`-createdAt`** |

**Business name is deliberately not sortable.** It lives on `stores`, not `vendors`, so sorting
by it would require a `$lookup` before the `$sort` — which cannot use an index and cannot carry
the tiebreaker that keeps paging stable.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | Matches **business name** (resolved against `stores` first), display name, email, phone, and — when the term is a 24-hex id — the **vendor id or its user id** |
| `status` | `active` \| `pending_verification` \| `inactive` | |
| `kycStatus` | `pending` \| `verified` \| `rejected` | |
| `onboarding` | `complete` \| `incomplete` | |
| `country` | 2 letters | ISO-3166 alpha-2, upper-cased automatically |
| `from` / `to` | ISO-8601 instant | Creation range. **Max span 366 days** |
| `page`, `limit`, `sort` | | |

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6650aa11bb22cc33dd44ee55",
      "userId": "665f1c2a9b3e4a91c7d2e5f0",
      "businessName": "Douala Fresh Market",
      "storeSlug": "douala-fresh-market",
      "displayName": "Marcel T.",
      "email": "marcel@doualafresh.cm",
      "phone": "+237699887766",
      "country": "CM",
      "status": "active",
      "kycStatus": "verified",
      "verified": true,
      "onboardingStep": 0,
      "onboardingComplete": true,
      "createdAt": "2025-11-03T09:14:00.000Z",
      "updatedAt": "2026-08-02T11:20:14.311Z"
    }
  ],
  "meta": { "total": 214, "page": 1, "limit": 20, "pages": 11 }
}
```

| Field | Notes |
|---|---|
| `onboardingStep` | jovi-mall's raw step number. **`0` means COMPLETE** — the inversion is easy to read backwards |
| `onboardingComplete` | The boolean, computed once so nobody re-derives it wrongly |
| `verified` | Business verification granted |
| `kycStatus` | The verdict. `pending` for rows written before the verdict existed |

#### Extra `meta` field

| Field | When |
|---|---|
| `businessNameMatchesTruncated: true` | Only when a `search` term matched more business names than the lookup could return. **Render a "results may be incomplete" hint** — a silent cap would produce a short list that reads as complete |

---

## `GET /vendors/:vendorId`

The full picture: the vendor, their store, the account behind them, their settings, and an
operational tally.

| | |
|---|---|
| **Permission** | `vendors.read` |
| **Path parameter** | `vendorId` — 24-hex |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "id": "6650aa11bb22cc33dd44ee55",
    "userId": "665f1c2a9b3e4a91c7d2e5f0",
    "businessName": "Douala Fresh Market",
    "storeSlug": "douala-fresh-market",
    "displayName": "Marcel T.",
    "email": "marcel@doualafresh.cm",
    "phone": "+237699887766",
    "country": "CM",
    "status": "active",
    "kycStatus": "verified",
    "verified": true,
    "onboardingStep": 0,
    "onboardingComplete": true,
    "createdAt": "2025-11-03T09:14:00.000Z",
    "updatedAt": "2026-08-02T11:20:14.311Z",

    "store": {
      "id": "6650aa11bb22cc33dd44ee60",
      "name": "Douala Fresh Market",
      "slug": "douala-fresh-market",
      "description": "Fruit, vegetables and dry goods.",
      "logoFileId": "6650aa11bb22cc33dd44ee61",
      "bannerFileId": null,
      "supportEmail": "help@doualafresh.cm",
      "supportPhone": "+237699887766",
      "supportWhatsapp": "+237699887766",
      "isOpen": true,
      "createdAt": "2025-11-03T09:20:00.000Z"
    },

    "account": {
      "id": "665f1c2a9b3e4a91c7d2e5f0",
      "email": "marcel@doualafresh.cm",
      "phone": "+237699887766",
      "roles": ["vendor"],
      "status": "active",
      "suspension": null
    },

    "suspension": null,

    "verification": {
      "status": "verified",
      "verified": true,
      "rejectionReason": null,
      "verifiedAt": "2025-11-08T14:00:00.000Z",
      "reviewedBy": { "id": "665f…", "source": "wi-admin", "name": "Ada Nkemelu" }
    },

    "contact": {
      "emailVerified": true,
      "phoneVerified": true,
      "whatsappVerified": false,
      "timezone": "Africa/Douala",
      "preferredLanguage": "fr"
    },

    "addresses": [
      { "id": "6650…", "label": "Warehouse", "addressLine1": "Rue Njo-Njo 14",
        "addressLine2": null, "city": "Douala", "state": "Littoral" }
    ],

    "policies": {
      "policyVersion": 3,
      "hasReturnPolicy": true,
      "hasCancellationPolicy": true,
      "hasSupportPolicy": false
    },

    "settings": {
      "autoRedirectOrdersToAgency": false,
      "autoRedirectThresholdAmount": null,
      "autoCancelUnpaidDays": 3,
      "notifyDaysBeforeExpiry": 7
    },

    "defaultDeliveryAgencyId": "665c0011223344556677889a",

    "counts": {
      "products": { "active": 128, "draft": 9, "suspended": 2, "archived": 14 },
      "orders": { "total": 3401, "lastOrderAt": "2026-08-13T06:41:09.220Z" },
      "agencyConnections": { "active": 2, "pending": 1, "paused": 0 }
    }
  }
}
```

#### Field notes

| Field | Notes |
|---|---|
| `store` | `null` when the vendor has no store yet |
| `store.isOpen` | **The vendor's own vacation switch, not an admin suspension.** Two different things that both make a shop look closed |
| `account` | The `users` row. `null` if it is missing — which would stop them signing in |
| `suspension` | **Present only when `status === "inactive"`.** Carries `at`, `reason`, `fromStatus` and `by` |
| `verification.reviewedBy` | `null` while the verdict is still `pending` |
| `addresses` | Business addresses. **Never payout details** — those are excluded by projection |
| `policies` | **Presence, not content.** ~30 fields of the vendor's own commercial terms exist; the question a detail screen asks is "have they set this up" |
| `settings` | jovi-mall's schema defaults where no document exists — `vendor_settings` is created lazily, so an untouched vendor shows defaults rather than nulls |
| `counts.products` | Keyed by status; only non-zero statuses appear |

Nothing sensitive is ever returned: `payout_details` and `kyc_details.national_id_number` are
excluded by the read projection **and** by the DTO naming its own fields.

### Errors

| Status | Code |
|---|---|
| 400 | `VALIDATION_ERROR` — "Not a valid vendor id" |
| 404 | `NOT_FOUND` — "Vendor not found" |

---

## `GET /vendors/:vendorId/products`

The catalogue, as platform oversight sees it.

| | |
|---|---|
| **Permission** | `vendors.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `createdAt`, `updatedAt`, `lastOrderedAt`. Default **`-createdAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `search` | string, 1–120 | |
| `status` | `draft` \| `active` \| `archived` \| `pending_review` \| `suspended` | |
| `type` | `physical` \| `digital` \| `service` | |
| `mode` | `simple` \| `advanced` | |
| `suspensionReason` | see below | Only meaningful alongside `status=suspended`; harmless otherwise |

#### `suspensionReason` values

`default_delivery_agency_removed`, `product_delivery_agency_removed`,
`agency_connection_paused`, `agency_storage_suspended`, `vendor_suspended`,
**`platform_oversight`**

This filter earns its place: *"which of this vendor's listings did **we** take down, and which
did their agency"* is unanswerable without it, and the two have very different remedies.
`platform_oversight` is the reason set by `POST …/products/:productId/suspend`.

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "66601122334455667788990a",
      "title": "Plantain — 1 kg",
      "slug": "plantain-1kg",
      "category": "produce",
      "type": "physical",
      "status": "suspended",
      "mode": "simple",
      "hasVariants": false,
      "suspension": {
        "reason": "platform_oversight",
        "previousStatus": "active",
        "at": "2026-08-10T13:02:41.008Z",
        "byAgencyId": null,
        "note": "Mislabelled weight — three customer complaints"
      },
      "deliveryAgencyId": "665c0011223344556677889a",
      "lastOrderedAt": "2026-08-09T18:22:00.000Z",
      "createdAt": "2026-01-20T07:00:00.000Z",
      "updatedAt": "2026-08-10T13:02:41.008Z"
    }
  ],
  "meta": { "total": 153, "page": 1, "limit": 20, "pages": 8 }
}
```

| Field | Notes |
|---|---|
| `mode` | `"advanced"` for documents predating the field |
| `suspension` | `null` unless suspended. `byAgencyId` is set when an agency caused it |

### Errors

`404 NOT_FOUND` when the vendor does not exist — checked first, so an empty catalogue reads as
"they sell nothing" only when that is true.

---

## `GET /vendors/:vendorId/activity`

What administrators have done to this vendor: every suspension, reinstatement, verification
decision, product takedown and settings change.

**Not** the vendor's own platform activity — their orders, shipments and catalogue edits live
in other domains behind other permissions.

| | |
|---|---|
| **Permission** | `vendors.read` **+** `audit.read` |
| **Pagination** | `page`, `limit` |
| **Sorting** | `occurredAt` only. Default **`-occurredAt`** |

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `action` | enum | Only `vendors.*` actions — derived from the audit catalog, so it widens automatically |
| `status` | `attempted` \| `succeeded` \| `failed` \| `denied` \| `queued` | |
| `from` / `to` | ISO-8601 instant | Max span 366 days |

### Response (200)

Audit entries, identical shape to [`GET /audit`](audit.md#get-audit).

---

## `POST /vendors/:vendorId/suspend`

Suspend a vendor. **Heavier than it looks: this takes their whole catalogue off sale inside one
jovi-mall transaction.**

| | |
|---|---|
| **Permission** | `vendors.suspend` |
| **Transport** | Delegated |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters |

```json
{ "reason": "Repeated counterfeit listings — see ticket TCK-2026-1140" }
```

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "id": "6650aa11bb22cc33dd44ee55",
    "userId": "665f1c2a9b3e4a91c7d2e5f0",
    "displayName": "Marcel T.",
    "email": "marcel@doualafresh.cm",
    "phone": "+237699887766",
    "country": "CM",
    "status": "inactive",
    "suspension": {
      "at": "2026-08-13T09:40:11.502Z",
      "reason": "Repeated counterfeit listings — see ticket TCK-2026-1140",
      "fromStatus": "active",
      "by": { "id": "665f…", "source": "wi-admin", "name": "Ada Nkemelu" }
    },
    "verification": { "status": "verified", "verified": true, "rejectionReason": null,
                      "verifiedAt": "2025-11-08T14:00:00.000Z", "reviewedBy": { "…": "…" } },
    "onboardingStep": 0,
    "createdAt": "2025-11-03T09:14:00.000Z",
    "suspendedProductCount": 128
  },
  "message": "Vendor suspended — 128 listing(s) taken off sale"
}
```

`suspendedProductCount` appears on this response only.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or too-short reason |
| 404 | `NOT_FOUND` | No such vendor |
| 409 | `PLATFORM_OPERATION_REJECTED` | Already suspended. `details.platformCode: "VENDOR_STATUS_CONFLICT"` — a compare-and-set, so two administrators holding one vendor's screen cannot overwrite each other's reason |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`vendors.suspend`

---

## `POST /vendors/:vendorId/restore`

Lift a vendor suspension. **Re-runs the activation gate on every listing** rather than blindly
republishing.

| | |
|---|---|
| **Permission** | `vendors.suspend` |
| **Request body** | None |

### Response (200)

The vendor DTO with `status: "active"`, plus `restoredProductCount` and `restoredProducts`
(`[{ productId, status }]`), and the message
`"Vendor restored — 96 listing(s) back on sale"`.

> **Fewer listings usually come back than went down, and that is correct.** A listing that no
> longer passes the activation gate stays suspended. Show both numbers, or an operator will read
> the difference as a partial failure.
>
> A product suspended by `platform_oversight` is **never** republished by this call — only
> `POST …/products/:productId/restore` lifts that.

### Audit

`vendors.reinstate`

---

## `POST /vendors/:vendorId/kyc/approve`

Approve business verification.

| | |
|---|---|
| **Permission** | `vendors.kyc.review` |
| **Body** | **Strict** |

### Request body

| Field | Type | Rules |
|---|---|---|
| `note` | string | **Optional**, ≤ 500 characters — an approval explains itself |

```json
{ "note": "RCCM and tax certificate both verified against the registry" }
```

### Response (200)

The vendor DTO with `verification.status: "verified"`, message
`"Business verification approved"`.

### Audit

`vendors.kyc.approve`

---

## `POST /vendors/:vendorId/kyc/reject`

Reject business verification.

| | |
|---|---|
| **Permission** | `vendors.kyc.review` |

### Request body

| Field | Type | Rules |
|---|---|---|
| `reason` | string | **Required.** 3–500 characters |

A rejection requires a reason where an approval does not: a rejection the vendor cannot see the
cause of is one they can only respond to by re-submitting blind.

```json
{ "reason": "The tax certificate is expired — upload a current one" }
```

### Response (200)

The vendor DTO with `verification.status: "rejected"` and `verification.rejectionReason` set.

### Audit

`vendors.kyc.reject`

---

## `POST /vendors/:vendorId/products/:productId/suspend`

Take one listing off sale, as platform oversight.

Nested under `/:vendorId` because **the ownership is the authorisation** — jovi-mall scopes the
write by both ids, so a product belonging to another vendor cannot be acted on by naming this
one.

| | |
|---|---|
| **Permission** | `vendors.products.manage` |
| **Path parameters** | `vendorId`, `productId` — both 24-hex |

### Request body

| Field | Type | Rules |
|---|---|---|
| `note` | string | **Required.** 3–500 characters |

```json
{ "note": "Mislabelled weight — three customer complaints" }
```

### Response (200)

The product, with `suspension.reason: "platform_oversight"` and the message
`"Product taken off sale"`.

> The reason is deliberately distinct from the vendor cascade's, so **reinstating the vendor can
> never silently republish a listing an administrator took down on its own merits.** Only the
> restore below lifts it.

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `NOT_FOUND` | No such vendor, **or the product does not belong to this vendor** |
| 409 | `PLATFORM_OPERATION_REJECTED` | Already suspended |

### Audit

`vendors.products.suspend`

---

## `POST /vendors/:vendorId/products/:productId/restore`

Put the listing back on sale.

| | |
|---|---|
| **Permission** | `vendors.products.manage` |
| **Request body** | None |
| **Response** | The product, message `"Product put back on sale"` |

### Audit

`vendors.products.restore`

---

## `PATCH /vendors/:vendorId/settings`

The platform-governed slice of a vendor's settings.

**The rule that decides what is here:** a setting is an administrator's to change when its
effect lands on somebody **other than** the vendor — the platform's unpaid-order sweep, the
agency receiving the shipment, or the customer waiting. A setting whose only effect is on the
vendor's own screen or inbox is theirs.

| | |
|---|---|
| **Permission** | `vendors.settings.manage` |
| **Body** | **Strict.** Naming an absent setting is a `400` here, before the request reaches jovi-mall — a call that looks like it changed a setting must never come back `200` having changed nothing |

### Request body

At least one field required.

| Field | Type | Rules |
|---|---|---|
| `autoCancelUnpaidDays` | integer | 1–90 |
| `autoRedirectOrdersToAgency` | boolean | |
| `autoRedirectThresholdAmount` | number \| null | ≥ 0. **`null` clears the cap** — every order auto-dispatches while the flag is on |

Bounds mirror jovi-mall's own schema, so an administrator cannot write a value the vendor's own
screen would refuse.

```json
{ "autoCancelUnpaidDays": 5, "autoRedirectOrdersToAgency": true, "autoRedirectThresholdAmount": null }
```

#### Deliberately absent

| Setting | Why |
|---|---|
| `notifyDaysBeforeExpiry` | A notification to the vendor, about the vendor. Theirs |
| `customerFlags` | Their private CRM vocabulary, referenced by their own records — editing it fans out |
| **Commission** | Lives on the billing `PricingPlan`, set by assigning a plan. **Nothing here should be extended to reach it** |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "autoCancelUnpaidDays": 5,
    "autoRedirectOrdersToAgency": true,
    "autoRedirectThresholdAmount": null
  },
  "message": "Vendor settings updated"
}
```

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Empty body ("Nothing to update"), an **unknown or non-admin setting**, or a value out of bounds |
| 404 | `NOT_FOUND` | |
| 502 / 503 | `SERVICE_DEPENDENCY_UNAVAILABLE` | |

### Audit

`vendors.settings.update`

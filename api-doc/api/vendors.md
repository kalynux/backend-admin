# `/vendors` — vendor management

**Verified against source on 2026-09-08** — all thirteen routes and their composed guards against the live route manifest, and every query parameter, sort allowlist, pinned status/type/mode/suspension-reason enum, `reason` requirement and the 366-day span against `vendors/validators/vendor.validator.ts` and `vendors/repositories/vendor-context.read.repository.ts:175-178`.

Base path: `/api/v1/vendors`

The directory, the detail, the catalogue as oversight sees it, the delivery-agency connections,
business verification, suspension, per-product takedown, and the platform-governed order
settings.

Design record: [`../../docs/ADR-008-VENDOR-MANAGEMENT.md`](../../docs/ADR-008-VENDOR-MANAGEMENT.md).

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/vendors` | `vendors.read` | direct read | — |
| `GET` | `/vendors/:vendorId` | `vendors.read` | direct read | — |
| `GET` | `/vendors/:vendorId/products` | `vendors.read` | direct read | — |
| `GET` | `/vendors/:vendorId/agencies` | `vendors.read` **+** `agencies.read` | direct read | — |
| `GET` | `/vendors/:vendorId/activity` | `vendors.read` **+** `audit.read` | direct read | — |
| `GET` | `/vendors/:vendorId/verification` | `vendors.read` | **delegated** | — |
| `POST` | `/vendors/:vendorId/suspend` | `vendors.suspend` | **delegated** | ✅ |
| `POST` | `/vendors/:vendorId/restore` | `vendors.suspend` | **delegated** | ✅ |
| `POST` | `/vendors/:vendorId/kyc/approve` | `vendors.kyc.review` | **delegated** | ✅ |
| `POST` | `/vendors/:vendorId/kyc/reject` | `vendors.kyc.review` | **delegated** | ✅ |
| `GET` | `/vendors/:vendorId/products/:productId` | `vendors.read` | **delegated** | — |
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

> ⚠ **`status: "active"` is NOT evidence that anybody vetted this vendor, and it stopped
> being so on 2026-09-15.** It used to be: the account waited on an administrator, so
> reaching `active` meant a human had approved it. The two questions were split —
> **`status`** answers *may this account operate*, and the holder earns it themselves by
> verifying a phone number; **`kycStatus`** answers *has a human vetted this business*, and
> only an administrator writes it.
>
> Any trust badge, "verified business" marker or warning banner derived from
> `status === "active"` is now wrong — re-point it at `kycStatus`. And do not read
> verified-ness as `kycStatus !== "rejected"`: "never reviewed" is not approval, and on a
> young platform that is most accounts. Only `verified` means verified.


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
      "hasSupportPolicy": false,

      "returns": {
        "returnEligible": true,
        "returnWindowDays": 14,
        "refundType": "partial",
        "refundPercentage": 80,
        "returnShippingPayer": "customer_reimbursed_if_defect",
        "refundProcessingDays": 5,
        "returnConditionNotes": "Unopened packaging only",
        "inspector": "platform"
      },
      "cancellation": {
        "cancellable": true,
        "cancellationDeadline": "before_dispatch",
        "cancellationDeadlineDays": null,
        "cancellationFeeType": "percentage",
        "cancellationFeeValue": 10,
        "lateCancellationRefundType": "partial",
        "lateCancellationRefundValue": 50
      },
      "support": {
        "channels": [{ "type": "whatsapp", "contact": "+237670112233" }],
        "eligibilityNotes": null,
        "requiredInfo": ["order_number", "product_photo_video"],
        "availability": "business_hours",
        "availabilityDescription": "08:00–18:00 Mon–Sat",
        "languages": ["fr", "en"]
      },
      "documents": []
    },

    "settings": {
      "autoRedirectOrdersToAgency": false,
      "autoRedirectThresholdAmount": null,
      "autoCancelUnpaidDays": 3,
      "notifyDaysBeforeExpiry": 7
    },

    "defaultDeliveryAgencyId": "665c0011223344556677889a",

    "counts": {
      "products": { "total": 153, "draft": 9, "active": 128, "archived": 14,
                    "pendingReview": 0, "suspended": 2 },
      "orders": { "total": 3401, "lastOrderAt": "2026-08-13T06:41:09.220Z" },
      "agencyConnections": { "total": 9, "active": 6, "pending": 1, "pausedReapproval": 1,
                             "rejected": 1, "withdrawn": 0, "terminated": 0 }
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
| `policies` | **Content as well as presence, since the dashboard-request round.** The three booleans remain and are now *derived* from the content; `returns`, `cancellation` and `support` carry the terms themselves, each `null` when the vendor has stored none. See the field tables below |
| `policies.returns.inspector` | **Administrator-controlled upstream, never vendor input** — it names who adjudicates a claim, not a term the vendor set. The same field, with the same caveat, exists on an agency's `damage` block |
| `settings` | jovi-mall's schema defaults where no document exists — `vendor_settings` is created lazily, so an untouched vendor shows defaults rather than nulls |
| `counts.products` | Keyed by status. ⚠️ **Every key is always present, `0` included** — the block is built from a fixed set, not from the statuses that happened to occur. (This table used to say "only non-zero statuses appear", and the example omitted `total` and `pendingReview`. Both were wrong; corrected with BR-018) |
| **`counts.agencyConnections`** | The seven integers are a `$group` over **exactly the population** [`GET /vendors/:vendorId/agencies`](#get-vendorsvendoridagencies) returns as rows — one `vendor_agency_connections` document each, same collection, same vendor scope, no status filter on either. So `total` here equals `meta.total` on an unfiltered first page there, and `active` / `pending` / `pausedReapproval` / `rejected` / `withdrawn` / `terminated` each equal `meta.total` with the matching `?status=`. An operator reading both screens is reading one set of documents twice. Every key is always present here too |

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
| **`deliveryAgencyId`** | 24-hex id | The listings a given agency answers for — matched against the **resolved** agency, so it means the same thing as the `deliveryAgency` column beside it. Added with BR-018 |

#### `suspensionReason` values

`default_delivery_agency_removed`, `product_delivery_agency_removed`,
`agency_connection_paused`, `agency_storage_suspended`, `vendor_suspended`,
**`platform_oversight`**

This filter earns its place: *"which of this vendor's listings did **we** take down, and which
did their agency"* is unanswerable without it, and the two have very different remedies.
`platform_oversight` is the reason set by `POST …/products/:productId/suspend`.

#### `deliveryAgencyId` matches the **resolved** agency, not the stored override

⚠️ Most products carry no override at all, so asking for the **default** agency's listings
returns every product with no `delivery.agency_id` as well as those naming it explicitly.
Asking for any other agency returns only its explicit overrides. That is the same precedence
`deliveryAgency` on the row already uses, and it is deliberate: a filter matching the stored
column would disagree with the column printed beside it on the common case.

**This is the drill-down from `productCount`.** `meta.total` on this filtered page and
`productCount` on the matching row of
[`GET /vendors/:vendorId/agencies`](#get-vendorsvendoridagencies) are the same number,
computed from one shared rule — so a client may link straight from the count to the listings
behind it.

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
      "deliveryAgency": { "id": "665c0011223344556677889a", "businessName": "Littoral Express Delivery" },
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
| **`deliveryAgency`** | ⚠️ **Replaces `deliveryAgencyId`** — a breaking rename from the dashboard-request round. An object rather than an id for two reasons: it removes an N+1 (a client resolving the name itself makes one request per distinct agency, in every client ever built), and it removes a permission question — the catalogue tab requires `vendors.read` alone, so a caller without `agencies.read` could not resolve the name at all. Resolved as the product's own override, else the vendor's default |
| `deliveryAgency.businessName` | The Magazin's name. **`null` where it has none** — never `""`, and never the agency's `display_name`, which is a contact *person* |
| `deliveryAgency: null` | Neither the product nor the vendor names an agency. A real and diagnostic state: a physical product in that condition cannot be activated |

### Errors

`404 NOT_FOUND` when the vendor does not exist — checked first, so an empty catalogue reads as
"they sell nothing" only when that is true.

---

## `GET /vendors/:vendorId/products/:productId`

One listing, in full.

| | |
|---|---|
| **Permission** | `vendors.read` — the same as the list |
| **Transport** | **Delegated** |
| **Audited** | — |

Scoped by **both** ids: the ownership is the authorisation, so a `404` covers "no such
vendor" and "the product does not belong to this vendor" alike.

### ⚠️ Why this one read is delegated when every other vendor read is direct

Not a drift from ADR-004 D-2 but a consequence of **ADR-009 D-6**. Two things in this payload
can only be built where they live:

- **`media`** needs `storage.getPublicUrl(key)`, and which provider that is comes from
  `STORAGE_PROVIDER`. This service has no storage layer and must not grow one — a second copy
  of that configuration in a second deployment is exactly the drift the split exists to prevent.
- **`storage`** needs jovi-mall's storage-fee calculator. A copy of that arithmetic here would
  be a second opinion about what a vendor owes their agency.

So: a **record** whose projection needs machinery this service may not own is delegated.

### Response `200`

Every list field, plus:

```jsonc
{
  "media": {
    "images": [
      { "id": "6612…", "key": "products/2026/07/tomatoes-1.jpg",
        "url": "https://cdn.example.com/vendors/665a…/tomatoes-1.jpg",
        "access": "public",
        "mimeType": "image/jpeg", "size": 148213, "originalName": "tomatoes.jpg" }
    ],
    "primaryImage": { /* images[0], or null */ }
  },

  "pricing": {
    "amount": 4500,
    "compareAtAmount": 5200,
    "currency": "XAF",
    "range": null
  },

  "inventory": {
    "tracked": true,
    "available": 42,
    "reserved": 6,
    "sellable": 36,
    "lowStockThreshold": null,
    "allowOversell": false
  },

  "deliveryAgency": { "id": "665c…", "businessName": "Littoral Express Delivery", "status": "active" },

  "storage": {
    "basis": "per_sku_monthly",
    "storageBasedEnabled": true,
    "monthlyRatePerSku": 500,
    "quantity": 42,
    "monthlyEstimate": 21000,
    "currency": "XAF",
    "size": null
  },

  "variants": [
    {
      "id": "6613…", "name": "1 kg", "sku": "TOM-1KG", "status": "active",
      "amount": 4500, "compareAtAmount": 5200,
      "inventory": { "tracked": true, "available": 42, "reserved": 6, "sellable": 36,
                     "lowStockThreshold": 10, "allowOversell": false },
      "storage": { "basis": "per_sku_monthly", "storageBasedEnabled": true,
                   "monthlyRatePerSku": 500, "quantity": 42, "monthlyEstimate": 21000,
                   "currency": "XAF",
                   "size": { "lengthCm": 30, "widthCm": 20, "heightCm": 12,
                             "volumeCm3": 7200, "weightG": 1000, "source": "variant" } }
    }
  ]
}
```

### The fields that need saying out loud

| Field | Notes |
|---|---|
| `media.images` | Resolved `FileDetail` objects **with URLs**, thumbnail first, `image/*` only — a product's media may also hold a video or a spec sheet, and filtering is what makes the field's name true. Empty array when the listing carries none. Resolved from the **default variant**, falling back to the product's own media, which is the normal case |
| `pricing` | **`null` on a product with no variants at all** — a broken listing, and saying so is the point. `amount` is the default variant's; `range` is `{min,max}` only when active variants disagree, `null` when they agree |
| **`inventory.tracked`** | **`false` means stock is not counted, not that it is zero.** `available: 0` on a tracked listing is "sold out"; on an untracked one it is meaningless, and the two have opposite remedies. Every count below is `null` when this is `false` |
| `inventory.reserved` | Units held mid-checkout. The same filter checkout itself enforces — active, unexpired holds |
| `inventory.sellable` | `available − reserved`, floored at 0 |
| Product-level `inventory` | Summed across **active** variants. `tracked` is `false` if **any** of them is infinite-stock: a product one of whose units is uncounted has no honest total. `lowStockThreshold` is `null` at product level because the alert is per SKU — read it off the variant rows |
| `deliveryAgency.status` | The agency's own status, so a listing pointing at a deactivated agency is visible as such |

### `storage` — a published rate, not an invoice

| Field | Notes |
|---|---|
| `storageBasedEnabled` | **`false` means the agency does not offer warehousing at all**, so the estimate is 0 by definition rather than by accident. Say so on screen rather than printing a rate nobody agreed to |
| `monthlyRatePerSku` | The agency's published tariff, from `policies.pricing.storage_based` |
| `quantity` | The **catalogue** quantity the fee is quoted against — a figure both parties signed off on, since neither moves it unilaterally on a warehoused SKU. An infinite-stock SKU yields `0`; inventing a quantity for it would be a fabricated charge |
| `monthlyEstimate` | `monthlyRatePerSku × quantity` |
| `size` | Information for **sanity-checking** the rate — **never a multiplier**. The rate is flat per SKU. `source` says whether the dimensions came from the variant or the product's shipping defaults, because "we do not know how big this is" and "30×20×12" must be distinguishable on a screen justifying a charge. `null` at product level: a gallery of different-sized variants has no single size |

> ### There is no `accruedThisPeriod`, and there should not be
>
> **The platform does not track, invoice or act on storage payment.** The rate has been
> collected at agency onboarding since day one and has never been charged —
> `EarningsQuoteService` deliberately excludes it from the per-order split, because it is rent
> rather than a delivery fee. The only platform lever attached to it is the agency's own manual
> suspension.
>
> So `monthlyEstimate` is what the agency *should be charging* to shelve this listing, which it
> collects out of band. A field claiming what the vendor *owes this period* would be an invoice
> this platform never issued.

`storage: null` when the listing is not warehoused by an agency — a digital product, or a
physical one collected from the vendor's own address. **`null` and "zero rent" are different
facts** and must not both render as 0.

### `variants`

Every variant, **including archived ones**: a listing that went wrong is exactly what an
administrator opens this screen to understand, and hiding the archived unit makes a product with
one archived variant look like a product with none. Check `status`.

`[]` on a product with no variants — never `null`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed id |
| 404 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode` `VENDOR_NOT_FOUND` or `CATALOG_PRODUCT_NOT_FOUND` — no such vendor, or the product is not theirs |

---

## `GET /vendors/:vendorId/agencies`

The vendor's **delivery-agency connections**, as rows rather than as the seven integers on the
detail. The mirror image of the [agency roster](agencies.md#get-agenciesagencyidagents): that
one answers *"who works for this agency, and on what terms"*, this one answers *"which agencies
does this vendor ship through, and on what terms"*.

| | |
|---|---|
| **Permission** | `vendors.read` **+** `agencies.read` — composite, `all` mode |
| **Transport** | direct read |
| **Audited** | — |
| **Pagination** | `page`, `limit` (default 20, hard max 100) |
| **Sorting** | `createdAt`, `status`. Default **`-createdAt`** |

### Why both permissions

The rows name agencies and carry their business names, their contact people and their
commercial state, so gating on `vendors.read` alone would be a **second door onto the agency
directory** that bypasses the permission governing it. That is the same rule
[`/agencies/:agencyId/agents`](agencies.md#get-agenciesagencyidagents),
[`/agents/:agentId/contracts`](agents.md#get-agentsagentidcontracts) and
[`/shipments/:shipmentId/offers`](shipments.md) each state from their own side.

Both tiers that hold either permission hold both, so this costs nobody access — it states the
dependency so a future tier change cannot quietly open a side door. The alternative — withholding
`agency.businessName` from a caller lacking `agencies.read` — was rejected: that is a
projection that changes by caller, and `GET /system/errors` is the only endpoint on this
service that does that.

### ⚠️ Why this is a direct read, when the request asked for a delegated one

BR-018 proposed `Transport: Delegated`. It is **not**, and the rule that decides it is
ADR-004 D-2 as amended by ADR-009 D-1 / ADR-011 D-1:

> Delegate a read whose answer is a **verdict** the platform acts on.
> Read directly a read whose answer is a **record**.

A `vendor_agency_connections` document is a record. There is no verdict on this surface —
nothing here is a decision jovi-mall then acts on, and nothing about listing these rows can
leave a database inconsistent. The collection has carried `access: 'read'` in the platform
access table since Phase 6, and two shipped endpoints already read it from there
(`counts.agencyConnections` on the vendor detail, `policyVersionPausedConnections` on the
agency detail). Delegating would have meant building this query in jovi-mall behind an endpoint
whose only caller is this service.

**Every write on the collection stays delegated**, and there the reason is concrete rather than
precautionary: a status change on one of these rows suspends or restores the vendor's products
in the same transaction.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | One of `pending` · `active` · `rejected` · `withdrawn` · `paused_reapproval` · `terminated` |

**Every status is returned by default, terminal rows included.** A live-only default would make
a relationship's history impossible to fetch, which on an administrative surface is most of what
the screen is for: a `rejected` row is precisely what an operator opens this panel to explain.

`status` is validated for **shape, not membership** — a bounded string, not a pinned enum.
ADR-005 D-17: the vocabulary is jovi-mall's, and a copy here would mean a seventh
`ConnectionStatus` added there is silently unfilterable until somebody remembers this file.
Render an unrecognised value rather than rejecting it. (The roster this endpoint mirrors makes
the same call for the same reason; the `status` filter on `/vendors/:vendorId/products` is
pinned because that one is also rendered as a fixed set of tabs.)

### Response (200)

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "6690aabbccddeeff00112233",
      "agency": {
        "id": "665c0011223344556677889a",
        "businessName": "Littoral Express Delivery",
        "status": "active",
        "contactName": "Nadege M.",
        "country": "CM"
      },
      "status": "active",
      "isDefault": true,
      "productCount": 42,

      "requestedBy": "agency",
      "requestedAt": "2026-02-11T09:00:00.000Z",
      "respondedAt": "2026-02-11T14:20:00.000Z",

      "policyVersions": { "vendorAtApproval": 3, "agencyAtApproval": 7 },

      "reapproval": { "requiredFrom": null, "pausedAt": null, "pausedReason": null },
      "rejection": null,
      "withdrawal": null,
      "termination": null,

      "createdAt": "2026-02-11T09:00:00.000Z",
      "updatedAt": "2026-08-02T10:11:00.000Z"
    },
    {
      "id": "6690aabbccddeeff00112244",
      "agency": {
        "id": "665c0011223344556677889b",
        "businessName": null,
        "status": "pending_verification",
        "contactName": "Paul E.",
        "country": "CM"
      },
      "status": "terminated",
      "isDefault": false,
      "productCount": 0,

      "requestedBy": "vendor",
      "requestedAt": "2026-05-02T08:00:00.000Z",
      "respondedAt": "2026-05-02T11:30:00.000Z",

      "policyVersions": { "vendorAtApproval": 2, "agencyAtApproval": 4 },

      "reapproval": { "requiredFrom": null, "pausedAt": null, "pausedReason": null },
      "rejection": null,
      "withdrawal": null,
      "termination": {
        "byRole": "agency",
        "byUserId": "6650aabbccddeeff00119911",
        "at": "2026-08-01T09:15:00.000Z",
        "reason": "reapproval_declined",
        "note": "Coverage no longer includes Bafoussam"
      },

      "createdAt": "2026-05-02T08:00:00.000Z",
      "updatedAt": "2026-08-01T09:15:00.000Z"
    }
  ],
  "meta": { "total": 9, "page": 1, "limit": 20, "pages": 1 }
}
```

#### Field notes

| Field | Notes |
|---|---|
| **`agency`** | The same decoration [`GET /agents/:agentId/contracts`](agents.md#get-agentsagentidcontracts) returns. **`null` when the joined agency row is missing** — a connection pointing at an agency that no longer exists. The row survives rather than being dropped, because that broken state is exactly what an administrator opens this panel to find |
| `agency.businessName` | ⚠️ **The Magazin's business name, `null` where it has none** — never `""`, and never `contactName` substituted. An agency mid-onboarding legitimately has no business name yet and must still be identifiable by its id. The distinction BR-006 established holds here unchanged |
| `agency.contactName` | The contact **person** (`display_name` on the agency row). A different thing from the business — see above |
| `status` | The six-value token, rendered raw. Treat an unknown value as unknown, not as an error |
| **`isDefault`** | Whether this agency is the vendor's `defaultDeliveryAgencyId`. One boolean, saving the client a comparison against a field on a different payload |
| **`productCount`** | How many of **this vendor's** products this agency answers for — the product's own override, else the vendor's default. See the section below for what it counts and what it costs |
| `requestedBy` | `vendor` or `agency`. **On a `pending` row this is the entire question** — it says whose turn it is to answer, exactly as `terms.proposedBy` does on a pending contract |
| `policyVersions` | Each side's `policy_version` as it stood at the moment of (re)approval. `null` on a connection that was never approved |
| **`reapproval`** | Always a block, never `null` — it is a **state**, not an event. Populated only while `status === "paused_reapproval"`: `requiredFrom` names the side that must act, and `pausedReason` (`vendor_policy_changed` · `agency_policy_changed`) says whose edit caused it. **This is what makes a paused row actionable** |
| **`rejection` / `withdrawal` / `termination`** | ⚠️ **`null` when it did not happen, a whole object when it did** — the `dispute` pattern from [`GET /orders/:orderId`](orders.md), never a block of nulls that reads as "unknown". Each carries the actor's role, their user id and the timestamp; `rejection` adds a free-text `reason`, and `termination` adds `reason` (`unilateral` · `reapproval_declined`) and `note` |
| `*.byUserId` | A `jovi_mall` user id, or `null`. Read the **role** beside it first — an administrative actor's id does not resolve in that database |

> **`status_history` is deliberately not returned.** It is an unbounded array on every
> document, and a page of twenty connections would carry twenty trails. The dashboard did not
> ask for it. If a connection *detail* read is ever built, that is where it belongs.

#### The relationship to `counts.agencyConnections`

These rows and the seven integers on [`GET /vendors/:vendorId`](#get-vendorsvendorid) are the
**same population**, read from the same collection with the same vendor scope. `total` there
equals `meta.total` on an unfiltered first page here; each of the other six equals
`meta.total` with the matching `?status=`. An operator reading both screens is reading one
set of documents twice — the counts summarise, these rows enumerate.

### `productCount` — what it counts, and what it costs

**Definition.** Every **non-deleted** product of this vendor whose *resolved* delivery agency is
this one: the product's own `delivery.agency_id` override, else the vendor's
`defaultDeliveryAgencyId`. That is jovi-mall's own `resolveEffectiveAgencyId` precedence, and
it is the identical rule behind `deliveryAgency` on a catalogue row — one function, three call
sites, so this panel and the catalogue tab cannot disagree about the same products.

**Every status, not just `active`.** A draft or suspended listing still occupies the agency's
shelf, so the number relates to `counts.products.total` rather than to the active subset.

Two consequences worth stating, because both look like bugs:

- **The counts do not have to sum to `counts.products.total`.** A product naming no agency,
  belonging to a vendor with no default, resolves to nothing and is counted on no row. That is a
  real and diagnostic state — a physical product in that condition cannot be activated.
- **A `pending`, `rejected` or `withdrawn` connection reports `0`**, and that is the truth
  rather than a gap: only an `active` connection lets a vendor point a product at that agency.
  A `terminated` or `paused_reapproval` row may still report a non-zero count, because the
  products keep the override they were given.

#### It is cheap, and here is the measurement

BR-018 asked whether to drop the column rather than ship a slow endpoint. It is kept, because
the expensive shape is not the one that was built:

| | |
|---|---|
| **Rejected** | A `countDocuments` per row — nine connections, nine scans of the same catalogue to answer one question, and nine numbers that can disagree with each other if a product moves while they run |
| **Built** | **One** `$group` over the vendor's catalogue for the whole page, keyed on `delivery.agency_id`, folded onto the vendor's default afterwards |

The cost is therefore **one query per request regardless of page size**, and its plan is
`$match: { vendorId, deletedAt: null }` — served by the `vendorId` prefix of the existing
`{ vendorId, slug }` unique index — then a fetch-and-group bounded by **one vendor's**
listings. That is the same index, the same range and the same plan as the `counts.products`
breakdown that `GET /vendors/:vendorId` has computed on every call since Phase 6. This
endpoint adds a cost the vendor detail was already paying, not a new class of one.

No dedicated index is proposed. `products` carries a single-key
`{ 'delivery.agency_id': 1 }` for the cross-vendor agency cascade, which a vendor-scoped group
cannot use, and a `{ vendorId, 'delivery.agency_id' }` compound would exist to serve one
grouped count on one screen.

**The drill-down was built as well as the count**, because it makes the number verifiable rather
than merely displayed: `GET /vendors/:vendorId/products?deliveryAgencyId=…` returns the
listings behind it, and its `meta.total` is the same number by construction.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | "Not a valid vendor id"; `limit` above 100; a `sort` key outside `createdAt` / `status`; a blank `status` |
| 403 | `AUTHZ_PERMISSION_DENIED` | The caller holds one of the two permissions and not the other. `details.required` names the **missing** ones and `details.mode` is `"all"` — so a client can say which permission is short rather than "forbidden" |
| 404 | `NOT_FOUND` | "Vendor not found" — checked **first**, so an empty list reads as "they ship through nobody" only when that is true |

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

## `GET /vendors/:vendorId/verification`

**The evidence the two verdicts below rest on** — identity-card scans, the selfie holding the
card, the vendor's own geocoded home address, the hand-drawn location sketches, and the shop
addresses on the account with a `geocoded` flag on each.

Until this existed, the whole of what a reviewer could see here was
`kyc_details.national_id_number` — a string the vendor typed, checkable against nothing.

⚠ **It returns no verdict, no score and no `required` column.** The estimated-verdict badge and
the pre-populated rejection reason are the dashboard's to compute; this endpoint supplies facts.
⚠ **Every document has `url: null`** — the files are in a private storage tree. Render them
through the audited `GET /files/:fileId/content`.

Full contract, including the per-role checklist and the queue-filtering trap:
**[verification.md](verification.md)**.

| | |
|---|---|
| **Permission** | `vendors.read` — the Support-tier lookup, deliberately not `vendors.kyc.review` |
| **Transport** | Delegated to jovi-mall |
| **Audited** | No — the disclosure is the *picture*, and that is audited on `files.content.read` |

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

> ### ⚠️ This is the **only** call that lifts a `platform_oversight` suspension
>
> The other half of the interaction stated on `POST /vendors/:vendorId/restore`, repeated here
> because it is the route an operator reaches for and it is easy to miss from one side.
>
> Reinstating the **vendor** republishes only the listings that cascade took down; a product an
> administrator removed on its own merits stays down until this call. The reverse is equally
> true and equally deliberate: this call refuses a product suspended for **any other** reason —
> one an agency took down over unpaid storage is that agency's to release, and one the vendor
> cascade suspended comes back when the vendor does.

### Errors

| Status | Code | When |
|---|---|---|
| 404 | `NOT_FOUND` | No such vendor, **or the product does not belong to this vendor** |
| 422 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode: "VENDOR_PRODUCT_NOT_OVERSIGHT_SUSPENDED"` — it was taken down for a different reason. `details.reason` names which |
| 422 | `PLATFORM_OPERATION_REJECTED` | `details.platformCode: "VENDOR_PRODUCT_UNSUSPEND_BLOCKED"` — the activation gate refuses it. **`details.blockers` is the full checklist**, not the first failure: an operator fixing a listing needs every unmet requirement at once |

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

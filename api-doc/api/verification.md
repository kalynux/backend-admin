# `/verification` — the evidence behind a KYC verdict

**Written against source on 2026-09-14** — the three routes and their guards against the live
route manifest; the payload shape against
`jovi-mall/src/modules/identity-verification/dto/kyc.dto.ts`; the per-role slot table against
`jovi-mall/src/modules/identity-verification/domain/kyc-subject.ts`; and the privacy verdict
against `jovi-mall/src/core/storage/storage-trees.ts` (`kyc: 'private'`).

Not a route group of its own: one read hangs off each of the three party domains.

| Method | Path | Permission | Transport | Audited |
|---|---|---|---|---|
| `GET` | `/vendors/:vendorId/verification` | `vendors.read` | **delegated** | — |
| `GET` | `/agencies/:agencyId/verification` | `agencies.read` | **delegated** | — |
| `GET` | `/agents/:agentId/verification` | `agents.read` | **delegated** | — |

---

## What this closes

Until this existed, a verification verdict rested on **a number the applicant typed in**, and
nothing else:

| Role | The whole of what a reviewer could see | Checkable against |
|---|---|---|
| Vendor | `kyc_details.national_id_number` | nothing |
| Agency | `registration_number`, `transport_license_id` | nothing — and both describe a *company*, not the person holding the cash |
| Agent | `kyc.reference` — a free-text note an **administrator** had written themselves | itself |

So an administrator opening the approve dialog was being asked to certify an identity from a
string. Every verdict on the platform was therefore either a rubber stamp or a refusal, and
neither was evidence.

This endpoint returns the documents: the identity card front and back, a photograph of the
holder's face beside it, the applicant's own geocoded home address, hand-drawn sketches of the
locations, and — for an agent — the vehicle photographed with its rider.

---

## ⚠ The backend grades nothing. The dashboard does.

**This is the most important thing on the page, and it is a decision rather than an omission**
(owner, 2026-09-14).

There is no `estimatedVerdict` field. No `complete`. No `required` column. Not on any role, not
under any query parameter. The response is **facts**; the badge is **yours**.

| The backend supplies | The dashboard decides |
|---|---|
| a value, or `null` | whether that field was *required* for this role |
| a `FileDetail`, or `null` / `[]` | whether that document was *required* for this role |
| `geocoded: true \| false` per address | whether an ungeocoded address blocks approval |
| `status`, `submittedAt` | whether this record is ready to look at |
| — | the estimated verdict badge |
| — | the pre-populated rejection reason |

**Why it is split this way.** The required/optional rules are a *review policy*: they change
when the reviewers change their minds, and the people who change their minds own the dashboard.
Encoding them in jovi-mall as well would be one rule in two repositories that cannot both be
edited by the same person — and the failure mode is silent, because the two only disagree
later. It would also cost the applicant the thing the review exists to give them: a backend
that refused an incomplete submission could never let a *human* tell them what is missing.

Two consequences you must design for:

- **An applicant can submit an empty record**, and it will arrive in your queue. That is
  expected. Badge it and reject it with a reason.
- **Nothing will ever tell you a submission is "valid".** `POST /submit` succeeds on anything.

`jovi-mall test:kyc` § 4 fails if a completeness check appears on that side, so if you ever see
one, it is a regression rather than a feature.

---

## The checklist, per role

Required/optional below is **the reviewing rule, for you to implement** — the API enforces none
of it and returns every field for every role regardless.

### Vendor

| What the reviewer checks | Field | Rule |
|---|---|---|
| The store address is valid (geocoded) | `storeAddresses[].geocoded` | optional |
| The home address is valid (geocoded) | `homeAddress.geocoded` | **required only if there is no physical store** |
| ID card scan, front and back | `documents.idCardFront`, `documents.idCardBack` | required |
| The ID number | `idNumber` | required |
| A selfie holding the ID card | `documents.selfieWithId` | required |
| Hand-drawn sketch of the home location | `documents.homeAddressSketches[]` | **required only if there is no physical store** |
| Hand-drawn sketch of the store location | `documents.storeAddressSketches[]` | **required only if a store address is set up** |

### Agency

| What the reviewer checks | Field | Rule |
|---|---|---|
| The magazin/store address is valid (geocoded) | `storeAddresses[].geocoded` | optional |
| The home address is valid (geocoded) | `homeAddress.geocoded` | **required only if there is no physical magazin** |
| ID card scan, front and back | `documents.idCardFront`, `documents.idCardBack` | required |
| The ID number | `idNumber` | required |
| A selfie holding the ID card | `documents.selfieWithId` | required |
| Hand-drawn sketch of the home location | `documents.homeAddressSketches[]` | **required only if there is no physical magazin** |
| Hand-drawn sketch of the magazin location | `documents.storeAddressSketches[]` | **required only if a magazin address is set up** |

> ⚠ **An agency's premises come from the MAGAZIN**, not from the agency profile — business
> identity is not kept on the profile. You do not need to know that (the field is
> `storeAddresses` either way), but it is why this read is delegated to jovi-mall instead of
> read straight out of `jovi_mall` like the rest of the agency screen.

> An agency legitimately has no premises of its own: it may work only for vendors who have
> their own physical store. That is what makes the home address conditional rather than
> optional.

### Agent

| What the reviewer checks | Field | Rule |
|---|---|---|
| The home address is valid (geocoded) | `homeAddress.geocoded` | **required** |
| Hand-drawn sketch of the home location | `documents.homeAddressSketches[]` | **required** |
| The plate number | `plateNumber` | optional |
| A picture of the vehicle with the agent beside it | `documents.vehicleWithAgent` | required |
| ID card scan, front and back | `documents.idCardFront`, `documents.idCardBack` | required |
| The ID number | `idNumber` | required |
| A selfie holding the ID card | `documents.selfieWithId` | required |

> ⚠ `documents.vehicleWithAgent` is **not** the agent's ordinary vehicle photo. That one is
> public, set during onboarding, and shown to agencies browsing the directory; this one is a
> private KYC document showing the rider standing beside the vehicle. Do not substitute one for
> the other — they answer different questions.

> `storeAddresses` is **absent** from an agent's payload, not an empty array. An agent has no
> premises on this platform.

---

## Response

`GET /api/v1/vendors/:vendorId/verification`

```jsonc
{
  "success": true,
  "requestId": "…",
  "data": {
    "role": "vendor",

    // pending | verified | rejected  (an agent also has `unverified`)
    "status": "pending",
    // null until the applicant pressed submit. Non-null ⇒ under review ⇒ frozen.
    "submittedAt": "2026-09-12T09:14:22.000Z",
    // Whether the applicant can still change anything. Derived; see "The lock" below.
    "locked": true,
    "rejectionReason": null,
    "verifiedAt": null,

    "idNumber": "1084563219",

    // The applicant's own home, as submitted for verification.
    "homeAddress": {
      "label": "Home",
      "formattedAddress": "Bonapriso, Douala, Littoral, Cameroon",
      "coordinates": [9.7043, 4.0286],   // ⚠ [lng, lat] — GeoJSON order
      "provider": "locationiq",
      "geocoded": true                   // ⭐ the badge input
    },

    // The business addresses already on the account. Absent for an agent.
    "storeAddresses": [
      {
        "label": "Main Shop",
        "formattedAddress": "Rue Njo-Njo, Akwa, Douala, Cameroon",
        "coordinates": [9.6982, 4.0511],
        "provider": "locationiq",
        "geocoded": true
      },
      {
        "label": "Warehouse",
        "formattedAddress": "12 Rue de la Joie, Douala",  // hand-typed, never geocoded
        "coordinates": null,
        "provider": null,
        "geocoded": false                // ⭐ badge this one amber
      }
    ],

    "documents": {
      "idCardFront":  { "id": "66f…a1", "key": "kyc/2026/09/…jpg", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 842113, "originalName": "cni-recto.jpg" },
      "idCardBack":   { "id": "66f…a2", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 811902 },
      "selfieWithId": { "id": "66f…a3", "url": null, "access": "authorized", "mimeType": "image/jpeg", "size": 1204518 },
      "vehicleWithAgent": null,          // agent only; null here
      "homeAddressSketches":  [ { "id": "66f…b1", "url": null, "access": "authorized", "mimeType": "application/pdf", "size": 220144 } ],
      "storeAddressSketches": [ { "id": "66f…c1", "url": null, "access": "authorized", "mimeType": "image/png", "size": 640221 } ]
    },

    "review": {
      // null while nobody has decided. Populated once status leaves pending/unverified.
      "reviewedBy": { "id": "…", "source": "admin", "name": "A. Ngo" }
    },

    "limits": { "multiSlotMaxFiles": 10 }
  }
}
```

An **agent** adds two fields and drops `storeAddresses`:

```jsonc
{
  "role": "agent",
  "idNumber": "1084563219",
  "driversLicenseNumber": "CM-DL-88213",   // agent only
  "plateNumber": "LT 4412 AB",             // agent only, read from vehicle_info — optional by rule
  "documents": { "vehicleWithAgent": { "id": "…", "url": null, "access": "authorized" }, "storeAddressSketches": [] }
}
```

---

## ⚠ `url` is always `null`. Rendering a document

Every file here lives in jovi-mall's **private `kyc/` storage tree**, so `toFileDetail` returns
`url: null` with `access: "authorized"`. That is the normal, expected answer — **not a fault,
and not a broken image**. The `id` is the handle.

```
GET /api/v1/files/:fileId/content
```

Behind **`files.content.read`**, and **audited** — the row commits *before* the bytes are
fetched, and its failure is not caught, so an unreachable audit store discloses nothing. It
answers the raw bytes with `Content-Disposition: inline` and `Cache-Control: private, no-store`.

> ⚠ **Do not build an `<img src={url}>` against this payload.** `url` is typed `string | null`
> precisely so the compiler makes you look: a client that renders it shows a broken icon on
> every identity document in the system. Fetch the content route and render the blob.

### Why this read is not audited and the content read is

They disclose different things. This endpoint hands you names, sizes, types and handles —
roughly what `files.resolve` already gives any tier. **Looking at the picture is the
disclosure**, and that is the act the row describes. Auditing both would make every review two
rows and tell an investigator nothing the content rows do not.

That is also why the permission here is the ordinary `{vendors,agencies,agents}.read` rather
than the review permission: Support holds `read`, answers *"why was my shop rejected"* tickets,
and cannot answer one from a status alone. The **write** — the verdict — keeps its own
permission, because that is the act with consequences.

---

## The lock, and what `status` means

`locked` tells you whether the applicant can still change anything.

| `status` | `submittedAt` | `locked` | What it means |
|---|---|---|---|
| `pending` / `unverified` | `null` | `false` | **A draft.** Nobody has asked you to look. Keep it out of the queue. |
| `pending` | set | `true` | **Waiting for you.** Frozen while you decide. |
| `verified` | set | `true` | Approved. Frozen — the applicant cannot swap an approved ID card for somebody else's. |
| `rejected` | set | `false` | Refused. Unfrozen, so they can fix it and resubmit. |

> ⚠ **`status: "pending"` alone does NOT mean "waiting for review"** on a vendor or an agency.
> It is the schema default, so it also means *"this account has never touched verification"*.
> **Filter your review queue on `submittedAt !== null`**, never on `status` alone, or the queue
> lists every vendor who ever registered. An agent's enum has a separate `unverified` value and
> does not carry the ambiguity — the timestamp works for all three, which is why it exists.

A resubmission after a rejection clears `rejectionReason` (the old text describes documents that
have been replaced) and re-stamps `submittedAt`. The **verdict** stays `rejected` until a
reviewer moves it: the applicant cannot promote their own record.

---

## Writing the verdict

Unchanged, and deliberately still where it was. There is no write on this endpoint — a second
path to one field is how two endpoints end up disagreeing about what `legit_verified` means.

| Role | Approve | Reject |
|---|---|---|
| Vendor | `POST /vendors/:vendorId/kyc/approve` | `POST /vendors/:vendorId/kyc/reject` |
| Agency | `POST /agencies/:agencyId/verify` | `POST /agencies/:agencyId/reject` |
| Agent | `PUT /agents/:agentId/kyc` (`status: verified \| rejected \| pending`) | same route |

All three are audited, all three require a reason on rejection. **The pre-populated reason your
badge computes is sent as that reason** — the backend stores what you send and composes nothing.

---

## Errors

| Status | Code | When |
|---|---|---|
| `404` | `KYC_SUBJECT_NOT_FOUND` | No such vendor / agency / agent, or an account in a state that has no verification record |
| `403` | `AUTHZ_PERMISSION_DENIED` | Caller lacks `{vendors,agencies,agents}.read` |
| `503` | `SERVICE_DEPENDENCY_UNAVAILABLE` | `JOVI_MALL_BASE_URL` is not configured — this read is delegated |

The content route adds:

| Status | Code | When |
|---|---|---|
| `404` | `CATALOG_FILE_NOT_FOUND` | The record outlived the file (soft-deleted, or swept) |
| `409` | `STORAGE_DOWNLOAD_NOT_SUPPORTED` | The deployment's `STORAGE_PROVIDER` cannot stream (`firebase`, `cloudinary`). A configuration state, not an outage — render it as one |

---

## The applicant's side

What the vendor, agency and agent dashboards do with these documents is documented in their own
contracts, and is worth reading before designing the rejection copy — the slot names in your
payload are the slot names in their upload URLs:

- `jovi-mall/api-doc/vendor/identity-verification.md`
- `jovi-mall/api-doc/agency/identity-verification.md`
- `jovi-mall/api-doc/agent/identity-verification.md`

They are in a different repository, so those are paths rather than links — the link checker is
per-tree.

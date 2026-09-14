# `/employees` — the staff employment record

**Built 2026-09-14 (ADR-023).** Everything the company holds about a member of its own staff:
who they are, how to reach them, where they live, where they are paid, and what they are paid.

Base path: `/api/v1/employees`

> **This is not the vendor/agency/agent KYC surface.** That one is
> [`verification.md`](verification.md), it is about people applying to *use* the platform, and
> it grades nothing on the backend. This one is about the people *running* it, and it does —
> see [the activation gate](#the-activation-gate). Reading one page as though it were the other
> will produce a screen that is wrong in both directions.

| Method | Path | Permission | Reachable while `pending` | Audited |
|---|---|---|---|---|
| `GET` | `/employees/me` | *self* | ✅ | — |
| `PATCH` | `/employees/me` | *self* | ✅ | ✅ |
| `PUT` | `/employees/me/avatar` | *self* | ✅ | ✅ |
| `POST` | `/employees/me/documents/:slot` | *self* | ✅ | ✅ |
| `DELETE` | `/employees/me/documents/:slot/:fileId` | *self* | ✅ | ✅ |
| `GET` | `/employees/:adminId` | `employees.read` | ❌ | — |
| `PATCH` | `/employees/:adminId/employment` | `employees.employment.write` | ❌ | ✅ |

---

## Who can see this, and it is narrower than anything else on the service

**The subject, and a tier-1 Developer. Nobody else, at any tier.**

That includes tier 2 (Admin), who holds `allInFamily('administrators')` and can therefore
manage the administrator directory, suspend accounts and reset passwords — and still cannot
open a colleague's employee record. The two permissions live in their **own family**
(`employees`), granted to tier 1 alone, and the service refuses to boot if any other tier holds
one.

**There is one body, not two.** The employee and the Developer reading their file see exactly
the same response. Every field here was typed in *by* the employee about themselves, except the
employment block, which the company states *to* them — so there is nothing the subject does not
already know and nothing the reviewer may act on without seeing. Do not build a screen that
expects a redacted variant for some readers; there is not one.

**⚠ There is no listing route, at any tier.** No `GET /employees`. That is deliberate and
structural rather than a permission decision: a listing is how somebody asks *"show me every
salary"* or *"show me everybody's home address"*, and this record exists to answer those one
person at a time. The repository has no query that could build one. A payroll export, if it is
ever wanted, will be its own permission and its own audited route.

**⚠ There is no delete.** An employment record outlives the employment — that is most of what
it is for. Departure is `employment.endedOn`; access is removed by suspending the account.

---

## The `EmployeeRecord` object

```jsonc
{
  "adminId": "65f0000000000000000000aa",
  "accountStatus": "pending",          // repeated from the account, so one call drives the screen

  // ── Personal ──────────────────────────────────────────────────────────────
  "fullName": "Aminata Ngo Bell",      // LEGAL name — see the ⚠ below
  "dateOfBirth": "1994-03-12T00:00:00.000Z",
  "placeOfBirth": "Douala",
  "gender": "female",
  "nationality": "Cameroonian",
  "motherFullName": "Marie Ngo Bell",
  "fatherFullName": "Joseph Bell",
  "phones": [
    { "label": "personal", "number": "+237670001122" },
    { "label": "work",     "number": "+237690004455" }
  ],
  "relatives": [
    {
      "fullName": "Joseph Bell",
      "relationship": "father",
      "phones": [{ "label": null, "number": "+237677778888" }]
    }
  ],

  // ── Identity ──────────────────────────────────────────────────────────────
  "idNumber": "CM1234567",
  "idType": "national_id",
  "idExpiresOn": "2031-03-12T00:00:00.000Z",

  "homeAddress": {                     // a GeoAddress — see /geo
    "formatted_address": "Rue 1.234, Bonapriso, Douala, Cameroon",
    "coordinates": { "type": "Point", "coordinates": [9.7043, 4.0341] },
    "provider": "geoapify",
    "provider_place_id": "51f0…",
    "components": { "city": "Douala", "country_code": "CM", "…": null },
    "raw_input": "bonapriso douala",
    "resolved_at": "2026-09-14T09:12:00.000Z"
  },

  // ── Documents. IDS, never URLs — see below ────────────────────────────────
  "documents": [
    { "slot": "id_card_front",       "cardinality": "single", "fileIds": ["65f…01"] },
    { "slot": "id_card_back",        "cardinality": "single", "fileIds": ["65f…02"] },
    { "slot": "selfie_with_id",      "cardinality": "single", "fileIds": ["65f…03"] },
    { "slot": "home_address_sketch", "cardinality": "multi",  "fileIds": ["65f…04"] },
    { "slot": "home_exterior_photo", "cardinality": "single", "fileIds": [] },
    { "slot": "signed_contract",     "cardinality": "multi",  "fileIds": [] }
  ],

  // ── Money. MASKED for everybody, the subject included ─────────────────────
  "payoutMethods": [
    {
      "method": "mobile_money",
      "isPreferred": true,
      "mobileMoney": {
        "provider": "MTN",
        "phoneNumberMasked": "•••••••••1122",
        "accountName": "Aminata Ngo Bell"
      },
      "bank": null,
      "card": null
    }
  ],

  // ── Employment. The employee READS this and cannot write it ───────────────
  "employment": {
    "position": "Support lead",
    "department": "Customer Care",
    "employmentType": "permanent",
    "staffNumber": "WM-0042",
    "startedOn": "2026-02-01T00:00:00.000Z",
    "endedOn": null,
    "monthlySalaryMinor": 450000,      // MINOR UNITS — see the ⚠ below
    "currency": "XAF",
    "notes": null,
    "updatedAt": "2026-09-14T10:00:00.000Z",
    "updatedBy": "65f0000000000000000000bb"
  },

  // ── What is still missing before activation ───────────────────────────────
  "readiness": {
    "ready": false,
    "gaps": [
      { "code": "home_exterior_photo", "section": "documents", "message": "Upload a photograph of you in front of your home" }
    ]
  },

  "lastSelfUpdateAt": "2026-09-14T09:15:00.000Z",
  "createdAt": "2026-09-14T08:00:00.000Z",
  "updatedAt": "2026-09-14T10:00:00.000Z"
}
```

### Five things a client has to get right

**⚠ `fullName` is not `displayName`.** The account's `displayName` is what colleagues call you
and you may change it freely. This is what the state calls you, and a reviewer compares it
against a scanned card. They differ for perfectly ordinary reasons. Do not render one as the
other, and do not prefill one from the other.

**⚠ `monthlySalaryMinor` is in MINOR CURRENCY UNITS** — the platform's convention everywhere.
`450000` with `"currency": "XAF"` is 450,000 FCFA, because XAF has no minor unit. A client
sending `450000.5` is refused rather than silently rounded: a payroll figure that does not
reconcile is a conversation with a person.

**⚠ `documents[].fileIds` are IDS, never URLs**, and there will never be a `url` here. Every
one of these files is in a **private** storage tree, so a URL for it does not exist. Resolve the
metadata with [`GET /files?ids=`](files.md) and fetch the bytes with
`GET /files/:fileId/content`, which is **audited per file, fail-closed** — with the audit store
unreachable, nothing is disclosed.

**⚠ `payoutMethods` are masked for EVERYBODY**, including the person who typed them in. Payout
details are write-mostly by design: echoing an account number to anything that can read a
profile turns a session hijack into a banking leak, and nobody needs the digits back. Index `0`
is the preferred destination.

**⚠ A record that has never been touched is not a 404.** `GET /employees/me` on a brand-new
account answers `200` with a fully-shaped record — nulls, empty arrays, all six document slots
present with `fileIds: []`, and a complete `readiness.gaps` list. Render that, do not treat it
as an error.

---

## The document slots

Six, and the vocabulary is a closed contract — these strings are the `:slot` path segment and
the keys in `documents[]`.

| Slot | Cardinality | What it is | Required to activate |
|---|---|---|---|
| `id_card_front` | single | Front of the identity document or passport page | ✅ |
| `id_card_back` | single | Back of the identity document | ✅ |
| `selfie_with_id` | single | The employee holding their identity document | ✅ |
| `home_address_sketch` | multi (≤10) | A hand-drawn sketch of how to reach their home | — |
| `home_exterior_photo` | single | The employee standing in front of their house | — |
| `signed_contract` | multi (≤10) | The countersigned employment contract and any addenda | — |

**`single` REPLACES on re-upload.** There is one front of one identity card, so a second upload
means the first was bad. The displaced file is detached and soft-deleted immediately — it is a
photograph of a national identity card, and the unreferenced-file grace period is not the right
place for one.

**`multi` APPENDS**, up to ten. To replace one, `DELETE` it and upload again.

**⚠ `signed_contract` is deliberately not required for activation**, unlike the three identity
slots. An employee frequently starts before the paperwork is countersigned, and a gate that
blocked activation on a document the *company* owes *them* would stop the wrong person.

---

## The activation gate

**⚠ Unlike [`verification.md`](verification.md), the backend DOES enforce a required set here,
and the difference is deliberate rather than an inconsistency.**

The applicant-side KYC module states — as an owner decision taken the same week — that nothing
is required and the dashboard computes the verdict. An applicant is a member of the public the
platform is deciding whether to admit, and refusing their submission for incompleteness denies
them the one thing they need: to be told, by a human, what is missing and why.

An employee is somebody the company is about to hand administrative access to its own platform.
The Developer activating them is a colleague who can say what is missing in a message, so there
is no equivalent cost — and the failure being guarded against, somebody waved through on a blank
file, is a risk the company carries itself.

`POST /administrators/:adminId/activate` answers **`422 ADMIN_ACTIVATION_INCOMPLETE`** until all
of the following are present:

| `gaps[].code` | `section` | |
|---|---|---|
| `mfa_not_enrolled` | `security` | Only when this administrator's **tier** requires two-factor (`ADMIN_MFA_REQUIRED_TIER`) |
| `full_name_missing` | `personal` | |
| `date_of_birth_missing` | `personal` | |
| `id_number_missing` | `identity` | |
| `home_address_missing` | `address` | A *geocoded* address — see [`/geo`](geo.md) |
| `phone_missing` | `contact` | At least one |
| `payout_missing` | `payout` | At least one destination |
| `document_missing:id_card_front` | `documents` | |
| `document_missing:id_card_back` | `documents` | |
| `document_missing:selfie_with_id` | `documents` | |

**The same `readiness` block is on the SUBJECT's own read.** That is the point: the employee is
the person who can actually fix a gap, so a checklist only the reviewer could see would cost a
message every time. It is computed once, so the button the Developer sees disabled and the list
the employee sees outstanding can never disagree — render both from the same codes.

**`gaps` is also in `details.gaps` on the 422**, so a failed activation renders the same list
without a second call.

**⚠ There is no lock, unlike the applicant record.** An employee can edit their record after
activation, forever. They move house, change their phone, switch bank. The activation decision
is about the *person*, not about a snapshot of their paperwork, and every later change is
audited.

---

## `GET /employees/me`

The caller's own record. Never 404s. Reachable while `pending`.

## `PATCH /employees/me`

Everything the employee says about themselves. **Reachable while `pending`** — it is the whole
reason that state exists.

### Request body

Every field is optional; send only what changed. **Sending `null` or `""` clears a field.**
An empty body is refused (`400`) rather than treated as a no-op — a body with no recognised key
almost always means the client sent the wrong shape.

```jsonc
{
  "fullName": "Aminata Ngo Bell",
  "dateOfBirth": "1994-03-12",         // ⚠ YYYY-MM-DD, NOT an ISO instant
  "placeOfBirth": "Douala",
  "gender": "female",
  "nationality": "Cameroonian",
  "motherFullName": "Marie Ngo Bell",
  "fatherFullName": "Joseph Bell",

  "idNumber": "CM1234567",
  "idType": "national_id",
  "idExpiresOn": "2031-03-12",

  "phones":    [{ "label": "personal", "number": "+237670001122" }],
  "relatives": [{ "fullName": "Joseph Bell", "relationship": "father",
                  "phones": [{ "label": null, "number": "+237677778888" }] }],

  "homeAddress": { /* a candidate from GET /geo/search, verbatim */ },
  "payoutMethods": [{ "method": "mobile_money",
                      "mobile_money": { "provider": "MTN",
                                        "phone_number": "+237670001122",
                                        "account_name": "Aminata Ngo Bell" } }]
}
```

**⚠ Dates are calendar days, `YYYY-MM-DD`, and an ISO instant is refused.** An instant carries a
timezone, and a date of birth shifted by an offset is a person who is a day older in one reading
than another — which is exactly the discrepancy that makes an identity document appear not to
match.

**⚠ `phones`, `relatives` and `payoutMethods` are a FULL REPLACE when present**, not a merge.
Send the complete list. `null` or `[]` empties it. Omit the key to leave it alone.

**⚠ Every phone number must be full E.164** — a leading `+` and a country code.
`670001122` is refused.

**⚠ The schemas are `.strict()`.** An unknown key is a `400` naming it, not a silently dropped
field. That is not this service's default and it is deliberate here: the failure mode of a
lenient schema on an identity record is an employee who corrects their date of birth, gets a
`200`, and finds the old value still there.

**⚠ `employment` is not accepted here.** It is written through
`PATCH /employees/:adminId/employment` by a tier-1 Developer. Sending it is a `400`.

**⚠ `homeAddress` is a candidate from [`GET /geo/search`](geo.md), sent back verbatim.** Do not
hand-build one. The stored row records which provider resolved it and carries a
`provider_place_id` that can be looked up later; an address with coordinates typed in by hand
would validate and be unverifiable.

**Payout destinations:** only `mobile_money` is open for new configuration today. Sending
`bank` or `card` is refused with a message naming what is accepted. At most three entries;
index `0` is the preferred one. Card numbers and security codes are **refused, not stripped** —
a `200` would let a client conclude the PAN it sent is on file.

### Response (200)

The full `EmployeeRecord`, with `readiness` recomputed.

---

## `PUT /employees/me/avatar`

The administrator's own picture. Reachable while `pending`.

```jsonc
{ "fileId": "65f0000000000000000000cc" }   // or null to clear
```

Upload the image first through [`POST /files/upload`](files.md) and send back the `id` from the
returned `FileDetail`. An avatar is an ordinary media upload and lands in a **public** tree, so
it resolves to a real URL — unlike everything in `documents[]`.

**⚠ The file is not verified to exist.** Setting an avatar to an id you did not just receive
from an upload will store a broken reference, visible immediately. That is the same call every
other file reference on this service makes.

**⚠ It lives here, not on `PATCH /administrators/me`**, even though the column is on the account.
`PATCH /administrators/:adminId` can edit somebody else's profile; an avatar is yours.

---

## `POST /employees/me/documents/:slot`

Upload an identity document. **Multipart, field name `documents`.** Reachable while `pending`.

```
POST /api/v1/employees/me/documents/id_card_front
Content-Type: multipart/form-data; boundary=…

  documents: <file>
```

**⚠ Exactly ONE file per request.** A second part is refused outright. A multi-value slot is
filled one upload at a time — which is what a picker does anyway, and it is what lets the backend
refuse a full slot *before* spending the bandwidth rather than after.

**Accepted:** `image/jpeg`, `image/png`, `image/webp`, `application/pdf`. PDF is there because
"a scan" arrives from a phone as a JPEG and from a scanner app as a PDF; refusing either half
pushes people into converting files, which is the step at which a legible document becomes an
illegible one.

**⚠ PNG is NOT converted to WebP here**, unlike the general media pipeline. This is evidence
somebody may have to produce later, and re-encoding it through a lossy format is a bad trade.
Images are resized to a 3000px bound rather than 2048 — an identity card's number and a sketch's
street names are small features.

### Response (201)

The full `EmployeeRecord`, not just the created file — so a client that uploads a document
immediately learns whether that closed the last gap on the checklist. `meta` carries the
uploaded files, `maxBytes` and `fieldName`.

### Errors

| Code | Status | |
|---|---|---|
| `FILE_UPLOAD_NOT_MULTIPART` | 415 | Wrong content type |
| `FILE_UPLOAD_TOO_LARGE` | 413 | Over the administration upload limit |
| `EMPLOYEE_SLOT_FULL` | 422 | A `multi` slot is already at ten. `details` carries `{ slot, max, current, offered }` |
| `PLATFORM_OPERATION_REJECTED` | varies | The far side refused it — a disallowed type, or the virus scan |

## `DELETE /employees/me/documents/:slot/:fileId`

Removes the id from the slot and soft-deletes the file. Reachable while `pending`.

**⚠ `404 EMPLOYEE_DOCUMENT_NOT_FOUND`, never `403`.** The record is loaded by the caller's own
id, so another administrator's file is simply not in the slot — and a `403` would confirm that
the id names a real staff document belonging to somebody else.

---

## `GET /employees/:adminId`

A tier-1 Developer reading a colleague's file. `employees.read`.

**Not audited**, and that is a decision rather than an omission: this returns **ids**, and every
id whose content is sensitive needs a second call to `GET /files/:fileId/content`, which **is**
audited per file and fail-closed. The disclosure of the pictures is recorded where it happens —
one row per document — which is a strictly better trail than one row saying "opened the screen".

## `PATCH /employees/:adminId/employment`

What the company says about the employee. `employees.employment.write` (tier 1, flagged
`financial`).

```jsonc
{
  "position": "Support lead",
  "department": "Customer Care",
  "employmentType": "permanent",
  "staffNumber": "WM-0042",
  "startedOn": "2026-02-01",           // YYYY-MM-DD
  "endedOn": null,
  "monthlySalaryMinor": 450000,        // integer, minor units
  "currency": "XAF",
  "notes": null
}
```

**⚠ Its scope is narrower than the path suggests, and that is the design.** It cannot touch the
personal, identity, address, contact or payout halves — those have **no administrative write
path at all**. An employee states their own facts; the company states its terms. A Developer who
could rewrite a colleague's date of birth or payout destination would make the record evidence
of nothing.

An `endedOn` before `startedOn` is refused when both arrive in the same request.

---

## What the audit trail records — and what it does not

**⚠ Every row on this surface names the FIELDS that changed and never their values.**

`audit.read` is granted to tier 3, narrowed per row. A `before`/`after` diff carrying a salary,
a date of birth or a mother's maiden name would route this record's contents straight into the
one feed it is specifically withheld from — and the fact that the *actor* is tier 1 does not
help, because the row's audience is not the actor's.

So a row says `{ "fields": ["dateOfBirth", "motherFullName"] }`. That answers what an audit trail
is opened for — *who changed what, when* — without making the trail the leak.

The one exception is `employees.avatar.set`, which records the file id: it names a file in a
public tree that every administrator can already resolve.

| Action | Emitted by |
|---|---|
| `employees.record.update_self` | `PATCH /employees/me` |
| `employees.documents.upload` | The upload, as an **attempt**, before the bytes move |
| `employees.documents.attach` | Filing the uploaded id into a slot |
| `employees.documents.detach` | `DELETE /employees/me/documents/…` |
| `employees.avatar.set` | `PUT /employees/me/avatar` |
| `employees.employment.update` | `PATCH /employees/:adminId/employment` |

**`employees.documents.upload` commits BEFORE the body is streamed and its failure is not
caught** — with the audit store unreachable, no identity document is stored. If you see an
`attempted` row with no target, read it conservatively: a file may exist and this service cannot
say.

---

## Where the bytes actually live

wi-admin stores **no files**. The documents are streamed through to jovi-mall and land in a
storage tree called `admin-identity`, classified **private**.

That tree is separate from the applicant `kyc` tree on purpose. The two hold the same *kind* of
document about different *subjects* — applicants the platform is deciding whether to admit,
versus employees whose documents are an employment record — which means a different legal basis,
a different retention clock and a different answer to "export everything you hold about me".
Sharing a tree would silently apply any policy written for either to both.

jovi-mall stores the bytes and one "this file is in use" marker. **It records nothing about what
the file depicts** — not the slot, not the identity number, not the name, and certainly not the
salary. All of that is in wi-admin's private database behind a tier-1 permission.

---

## Related

- [`administrators.md`](administrators.md) — the `pending` status, and `POST /:adminId/activate`
- [`geo.md`](geo.md) — resolving the home address
- [`files.md`](files.md) — turning a `fileId` into metadata, and fetching the bytes
- [`verification.md`](verification.md) — the *other* identity surface, for vendors, agencies and agents
- [`errors.md`](errors.md#employee-records-adr-023) — the two `EMPLOYEE_*` codes

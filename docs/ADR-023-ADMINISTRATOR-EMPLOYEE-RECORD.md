# ADR-023 — The administrator employee record, and the `pending` account

**Status:** accepted · built 2026-09-14
**Supersedes nothing. Amends:** ADR-003 (a new permission family), ADR-006 (a new audit
payload rule), ADR-021 (a second upload path).

---

## The problem

An administrator account was three fields and a password: an email, a display name and a level.
It was created `active` and worked immediately. Two things follow from that, and both were
wanted rather than accidental — until the company had staff rather than founders.

**Nothing was known about the person.** An administrator holds the strongest credential on the
platform: they can suspend a vendor, move money, read a customer's order history and see where a
delivery agent is standing right now. The platform demands a scanned identity card and a selfie
from a vendor who wants to list a product, and demanded nothing at all from the person who
approves that vendor.

**There was no moment at which anybody decided to let somebody in.** `POST /administrators`
created a working account, so the act of hiring and the act of granting platform access were the
same API call, made by whoever happened to hold `administrators.create`.

---

## D-1 · A new account is `pending`, and can reach only its own record

`AdminStatus` gains a third value. Every account created through the API starts there.

**The schema default is the enforcement** (`status: { default: 'pending' }`), so an account
cannot become active by omission. Exactly one caller passes `'active'` explicitly: the bootstrap
CLI, creating the first administrator, who has nobody to activate them. `test:employees` § 1
asserts that it is exactly one.

### `pending` is not a flavour of `suspended`

They answer opposite questions — *has this person been let in yet* versus *has this person been
shut out* — and they behave differently at the gate:

| | `pending` | `suspended` |
|---|---|---|
| Sessions | **kept** | destroyed on the next request |
| Scope | everything outside the onboarding allowlist is refused | everything is refused |
| Code | `ADMIN_ACTIVATION_REQUIRED` | `ADMIN_AUTH_ACCOUNT_SUSPENDED` |
| Remedy | finish the employee record | a conversation with somebody |

Keeping the session is load-bearing. A new administrator's entire job is to fill in one form; a
gate that evicted their session on every request would sign them out of it.

### The allowlist, and the rule that was rejected

The gate consults `ONBOARDING_ROUTE_ALLOWLIST` — fifteen `METHOD /path` keys — rather than a
per-route declaration, mirroring `PUBLIC_ROUTE_ALLOWLIST`. A route not in it is closed, so one
added next year is closed without its author knowing the state exists.

**The obvious alternative was "a pending administrator may reach any `selfService` route", and
it is wrong.** Three routes carry `selfService` because their permission is resolved *per
request* against a queued action: `POST /approvals/:id/approve`, `/reject` and `/withdraw`.
Approving a four-eyes request is the most consequential act on this service, and a kind-based
rule would have handed it to somebody nobody had admitted yet. This was found by enumerating the
`selfService` routes before writing the rule, not after.

Two boot assertions keep the list honest: every entry must name a declared route, and every entry
must be `self`. The second is the stronger — an entry naming a `permission` route grants nothing
(`gateFor` refuses to apply the relaxed gate to one), but it would sit in the list looking like a
decision, and the next person to "fix" the inconsistency would remove the second lock rather than
the mistake.

**The list is deliberately not a complete inventory.** Four more routes are reachable while
pending — `GET /auth/me`, `POST /auth/logout`, `POST /auth/mfa/enroll`, `POST /auth/mfa/activate`
— because they declare `mfaEnrolment()`, and that gate lifts both half-states. They are not
listed because a route here that this list does not actually gate would be worse than an
omission: deleting the entry to close the route would close nothing.

### Reinstatement restores the prior status

⚠ **This was a live escalation introduced by adding `pending`, caught during the build.**
`setSuspension(null)` wrote `'active'` unconditionally, which was correct while `active` and
`suspended` were the only two states. With a third, suspending a not-yet-activated administrator
and reinstating them **activated** them — past the tier-1 decision that exists to let somebody
in, with an audit trail reading "reinstated", because that is what was asked for.

`suspended_from_status` is now recorded at suspension time and restored on reinstatement.
Inferring it from `activated_at === null` looks like it would work and does not: the bootstrapped
first administrator is `active` with a null `activated_at` by construction, so inference would
demote the one account that may have nobody left to re-activate it.

---

## D-2 · The employee record is a separate collection behind a separate permission family

`admin_employee_records`, 1:1 with `admin_accounts`, created lazily on first write.

### Why not fields on `admin_accounts`

Three reasons; the third decides it.

**Different audience.** The account is the DIRECTORY — every holder of `administrators.read`,
which is tiers 1 and 2, sees a name, a level and a status. This is an EMPLOYMENT FILE: a salary,
a date of birth, a mother's maiden name, a photograph of somebody's front door.

**Different write path.** Almost every field here is written by the employee about themselves.
`tier` and `status` are written by other people about them. Mixing self-service and
administrative writes into one `updateOne` is how an employee ends up able to set their own level.

**`tier-grants.ts` gives tier 2 `allInFamily('administrators')`, today.** Hanging this data off
the account document would put it one over-broad projection away from the permission that lets an
Admin manage the directory. A separate collection behind a separate family makes that mistake
impossible to make by accident rather than merely inadvisable.

### Why a new family rather than flags on existing names

`allInFamily()` refuses to expand anything flagged `escalation`, `financial` or `destructive`, so
the instinct is to flag these and leave them in `administrators`. Rejected: `escalation` means
"can widen who holds power", and reading somebody's mother's maiden name is not that. Using the
flag as a grant-scoping trick would misdescribe the permission in `GET /permissions/catalog`,
which administrators read.

A separate family says the true thing, and a **boot assertion** — `spec.family === 'employees' &&
tier !== 1` — is the mechanism, in the same shape as the existing `developer_tools` rule.
`test:employees` § 3 asserts that `allInFamily('employees')` *does* expand `employees.read`,
which is what proves the boot assertion is load-bearing rather than decorative.

### One body, not two

The subject and the tier-1 reviewer see the same response. Every field was typed in *by* the
employee except the employment block, which the company states *to* them — so there is nothing
the subject does not already know and nothing the reviewer may act on without seeing. A graded
projection would be two shapes to keep correct in order to hide a person's own date of birth from
them. The grading lives in **who may open it at all**, which is a far stronger bound than a field
list.

Payout destinations are masked for everybody, the subject included — the platform's standing rule
that payout details are write-mostly.

---

## D-3 · The avatar is on the ACCOUNT; the identity photographs are on the RECORD

Two pictures of the same face, two completely different audiences.

An avatar is how colleagues recognise you in a dropdown: directory data, a `by-type` upload, a
**public** storage tree, a real resolvable URL, visible to every administrator. A photograph of
you holding your identity card is evidence: a **private** tree, tier 1 and the subject, audited
per fetch.

So `avatar_file_id` is a column on `admin_accounts` and the document slots are columns on
`admin_employee_records`. Putting them together would force one of the two into the wrong
exposure.

`PUT /employees/me/avatar` lives on the employees mount even though it writes the account, because
`PATCH /administrators/:adminId` is also reachable in a form that edits somebody *else* — keeping
them apart is what stops one administrator setting another's picture through a shared handler.

---

## D-4 · The bytes go to a new PRIVATE tree in jovi-mall; nothing about them does

wi-admin stores no files. The documents stream through to jovi-mall and land in `admin-identity`,
classified `private` in `storage-trees.ts` and in wi-admin's verbatim copy of it.

### Why not `POST /files/upload`

⚠ **Because it writes to PUBLIC trees.** The existing admin upload proxy passes
`folder: 'by-type'`, `resolveTypeFolder` maps every media category onto one of
`images|videos|audio|documents|archives|other`, and `storage-trees.ts` classifies **all six
public** — served by `express.static` at a permanent, guessable URL. That is exactly right for a
blog cover and catastrophic for a national identity card.

The two gateways differ in one string, and that string is the entire privacy mechanism: there is
no `sensitive` flag on a file and no second gate. `test:employees` § 5 asserts the staff gateway
targets `/identity-documents` and never `/files/upload`.

### Why a new tree rather than the existing `kyc` one

They hold the same *kind* of document about different *subjects*. `kyc` holds applicants the
platform is deciding whether to admit, reviewed once, retention following the account. This holds
employees, whose documents are an employment record — a different legal basis, a different
retention clock, and a different answer to "export everything you hold about me". Sharing a tree
would mean a policy written for either silently applied to both, and the person writing it would
have no way to see that from the folder name.

### jovi-mall learns two facts and no more

It writes a `File` row (`ownerType: 'admin'`, `ownerId` a wi-admin id it can never dereference)
and one `file_references` row. **Not the slot** — the applicant module writes `kyc_<slot>` because
it owns the vocabulary *and* the record; here the record lives in wi-admin, and encoding the slot
would mean a second copy of that vocabulary kept in step by nothing, to answer a question
("is this file in use") that does not need it.

The reference row is not bookkeeping. Without it every staff identity document would appear on
`GET /files/orphans` the moment it was uploaded, and an administrator tidying the media library
would be shown a national identity card labelled "unused".

---

## D-5 · The backend enforces a required set — a DELIBERATE divergence from the applicant module

⚠ **jovi-mall's `core/types/kyc-documents.types.ts` states, as an owner decision taken the same
week, that the backend evaluates nothing, nothing is `required`, and the dashboard grades. This
ADR does the opposite. The two are not an inconsistency and must not be reconciled.**

An **applicant** is a member of the public the platform is deciding whether to admit. Refusing
their submission for incompleteness denies them the one thing they actually need — to be told, by
a human, what is missing and why — and the required/optional split there is a *review policy*
that changes when the reviewers change their minds.

An **employee** is a person the company is about to hand administrative access to its own
platform. The Developer activating them is a colleague who can say what is missing in a message,
so there is no equivalent cost; and the failure being guarded against, somebody waved through on
a blank file, is a risk the company carries itself.

The required set is: MFA (only where the tier requires it), full legal name, date of birth,
identity number, a geocoded home address, one phone, one payout destination, and the three
identity document slots. `signed_contract` is **not** in it — an employee frequently starts
before the paperwork is countersigned, and a gate blocking activation on a document the *company*
owes *them* would stop the wrong person.

`assessReadiness` is a **pure function returning a report**, not a throw. Two callers need two
things from one rule: the activation endpoint needs a verdict, and the record read needs a
checklist. A function that threw would serve the first and force the second to reimplement it,
which is how two copies of one policy start disagreeing.

⚠ **A missing record is graded exactly like an empty one.** The first implementation pushed a
single `record_missing` gap and guarded the field checks behind `if (record)`, so an
administrator who had never opened the form got a checklist with one line on it. `test:employees`
§ 6 caught it against the DTO's own documented promise.

MFA is checked through `mfaRequiredForTier`, not hardcoded, so this gate does not quietly
override `ADMIN_MFA_REQUIRED_TIER` in a second place nobody looking at that knob would find.

---

## D-6 · There is no listing route, and the repository has no query for one

No `GET /employees`, at any tier.

The permission does not stop that — tier 1 legitimately holds `employees.read`. What stops it is
that **the query does not exist**: `EmployeeRecordRepository` can find by `admin_id` and nothing
else. A listing is how somebody asks *"show me every salary"* or *"show me everybody's home
address"*, and this record exists to answer those one person at a time, for a named reason.

Same shape as geo-tracker's trail, which is reachable only by naming a shipment and has no
listing route of any kind: a structural bound cannot be widened by a configuration mistake.

There is also no delete. An employment record outlives the employment; departure is
`employment.endedOn`, and access is removed by suspending the account.

---

## D-7 · Reading somebody's record is NOT audited; fetching a document IS

This looks like a gap in a service whose rule is that a disclosure can be an action — the posture
`money.payouts.destination.read` established and the tracking and proof-photo reads inherited.

`GET /employees/:adminId` returns **ids**, not bytes and not anything a client can act on. Every
id whose content is sensitive requires a second call to `GET /files/:fileId/content`, which **is**
audited, per file, fail-closed. So the disclosure of the pictures is recorded where it actually
happens — one row per document — which is a strictly better trail than one row saying "opened the
screen".

What the read adds on top is the typed half: a salary, a date of birth. Auditing that would put a
row in a feed Support can read every time a Developer opens the screen, for a disclosure to the
one tier allowed it.

⚠ **If a future version returns anything actionable without a second call — a decrypted account
number, an inline image — this decision has to be revisited in the same change.**

---

## D-8 · Audit rows name the FIELDS that changed, never their values

⚠ Every other audited write on this service puts a `before`/`after` diff in the row, and that is
right for a plan change or a tier change. It is wrong here.

**`audit.read` is granted to tier 3**, narrowed per row by `auditScopeFilter`. A `before`/`after`
carrying a date of birth, a mother's maiden name or a home address would route this record's
contents into the feed it is specifically withheld from. That the *actor* is tier 1 does not help:
the row's audience is not the actor's.

So a row says `{ "fields": ["dateOfBirth", "motherFullName"] }`. That answers what an audit trail
is opened for — who changed what, when — without making the trail the leak. `test:employees` § 4
asserts the absence.

The one exception is `employees.avatar.set`, which records the file id: it names a file in a
public tree every administrator can already resolve.

`employees.documents.upload` is `external` transport and is registered in
`NON_ROUTE_AUDIT_PRODUCERS` despite being reached by a route — the row is an *attempt*, committed
before the bytes stream, and the route declares the *attach* that commits on success. Declaring
both would make every successful upload look like an unmet declaration to the audit probe.

---

## D-9 · Geocoding is delegated, not configured

wi-admin gains `/api/v1/geo/{search,reverse}`, delegating to a new
`/api/internal/admin/geo/{search,reverse}` in jovi-mall — the *same two handlers* its public
`/api/geo` mount serves, behind the service-token guard.

That mount is guarded by `requireAuth`, which resolves a platform `users` row. An administrator
has none. So the platform's geocoder was reachable by every role **except the one staffing it**,
and wi-admin could not offer an address field of any kind.

Giving wi-admin its own provider key was the alternative, and it is the hazard `CLAUDE.md` already
records about the Geoapify and LocationIQ keys: **a second spender on one free-tier quota** with
nothing anywhere adding the two together, so a burst on one side exhausts the allowance the other
depends on and the symptom lands in a different service from the cause.

The routes declare `selfService` rather than a permission. They act on no identity at all — a
public gazetteer, no platform data, no subject to grade by — so a permission would have to be
invented, and an invented permission is one somebody later grants to a tier for the wrong reason.
They are not audited: the address an administrator *stores* is recorded by the audited write that
stores it.

---

## What this cost on the other side

Two changes in jovi-mall, both additive, deployable producer-first:

- a new `admin-identity` storage tree (private), its upload policy, and
  `POST`/`DELETE /api/internal/admin/identity-documents`
- `/api/internal/admin/geo/{search,reverse}`, mounting the existing handlers

**No event shape, webhook body or existing route changed, and there was no migration.** The one
new index is the unique constraint on `admin_employee_records.admin_id`.

---

## Consequences worth knowing

- **Every new hire waits on a Developer.** A tier-2 Admin holds `administrators.create` and not
  `administrators.activate`, so they can mint a Support account and cannot turn it on. Accepted:
  it follows from the rule that staff records are tier-1-and-the-subject.
- **A `pending` administrator is a normal signed-in user to the auth layer.** Login, MFA and
  refresh are untouched. Only the request gate differs.
- **The employee record is never frozen.** Unlike the applicant record, which locks on submission
  so an approved applicant cannot swap the identity card a reviewer looked at. That reasoning does
  not carry here: people move house and change bank, and a record they cannot correct after
  activation is stale within a year. Every later change is audited, which is the control that
  replaces the freeze.
- **`avatar_url` on a support-ticket snapshot is still null** — and the *reason* changed. It is no
  longer "no administrator avatar exists"; it is that the stored field is a URL and this service
  holds an id. Recorded as a known follow-up in `support/domain/admin-snapshot.ts`.

## Open

- **O-1** — the ticket-snapshot avatar above. Two ways to close it; the better one
  (carry `avatar_file_id` in the stored snapshot) is a jovi-mall change.
- **O-2** — `admin_employee_records` has **no retention policy**, exactly like
  `tracking_audit` on the geo-tracker side. It is an employment record and an employment record is
  meant to outlive the employment, so this is not the same defect — but the obligation should be
  written down somewhere it can be acted on rather than inferred from an ADR.

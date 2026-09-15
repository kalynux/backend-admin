# BR-026 · The 2026-09-15 activation split has to reach wi-admin before this dashboard can act on it

**Raised** 2026-09-15, from jovi-mall's frontend brief
`backend/FRONTEND-SYNC/BRIEF-activation-verification-payouts.md`.
**Status:** ✅ **ANSWERED 2026-09-15** — [`RESPONSE-2026-09-15-BR-026.md`](RESPONSE-2026-09-15-BR-026.md).
All three sections done. § 1 built as a top-level `verification: { verified, verdict }`; § 2
confirmed as a real defect and fixed on agencies **and** vendors; § 3 corrected, including the
error-code rename you offered to take.

⚠ **One premise in § 1 below is wrong and the correction is good news** — wi-admin is **not** a
re-projection on `GET /money/payouts`; it reads `payout_requests` directly, so there was nothing
to forward and the field does **not** wait on jovi-mall's deploy. Left standing below as written.

**Originally:** open. **Blocking:** one item (§ 1). **Reporting:** two (§ 2, § 3).

> **The brief was addressed to four clients at once, and admin-dash is the only one that reaches
> jovi-mall through a second service.** The other three call jovi-mall directly, so for them the
> change is already described by the pages the brief names. Everything below exists because
> wi-admin re-projects those payloads under its own field names, and its contract was verified
> against source on **2026-09-08** — a week before the change.

---

## § 1 — `GET /money/payouts` must forward the new `verification` field · **blocking**

**The ask:** carry jovi-mall's new per-row `verification` onto wi-admin's payout queue.

jovi-mall added it to `GET /api/internal/admin/payout-requests` on 2026-09-15:

```json
"verification": { "verified": false, "verdict": "pending" }
```

and its own page is emphatic about why — *"Read this on every row before releasing funds. … without
this field an active vendor with a plausible destination is indistinguishable from a stranger who
registered this morning."* Payout review is the platform's one human checkpoint on money leaving it.

⚠ **We cannot implement this from the brief, because wi-admin is not a passthrough on this route
and we would be guessing the field name.** The re-projection already renames most of what it
touches:

| jovi-mall | wi-admin |
|---|---|
| `ownerType` · `ownerId` · `ownerName` (flat) | `owner: { type, id, name }` |
| `destination: { method, provider, last4 }` | `destination: { method, isPreferred, masked: {…}, full, revealed }` |
| `meta.totalPages` | `meta.pages` |

Against that record, three shapes are all plausible — top-level `verification`, nested under
`owner`, or flattened to `owner.verified` — and picking one would be a **transcription**, which is
the error this repository has shipped four times (`/content` on the wire, `agencies.md`'s `kyc`
members, `files.md`'s quota clause, `support.md`'s expiring URLs). **We would rather wait for the
projection than guess it.** Name it and we will build the row.

**What we would do with it, so the shape can be judged against the use:** render it on every row
of `PayoutsQueue`, not behind a detail click; branch only on `verified`; render `verdict` as the
role's own word; **never disable the pay button on it** — it is information, and the brief and
`payout-requests.md` both say the platform does not refuse these payouts. A filter on `verified`
if the list query will take one.

⚠ **Please keep it read-fresh rather than snapshotted**, as jovi-mall does. A frozen "unverified"
against a business already on file sends the reviewer chasing documents that have been submitted.

### What is NOT needed here

The brief's §3 warns that the documented response was wrong until 2026-09-15 — snake_case keys and
a **plaintext** payout number — and tells clients reading `payout_method_snapshot`, `_id`,
`owner_type` or `ticket_id` to re-check. ✅ **admin-dash reads none of those**, because it reads
wi-admin's shape, which has always been camelCase, and whose destination digits are *absent by
projection* rather than masked by a mapper. Checked by grep across `src/`: the only snake_case
occurrences are comments describing jovi-mall's internal `owner_type` pinning. **No client change
was needed for that half.**

---

## § 2 — An agency can now receive only one verdict, ever · **we think this is a bug in the change**

🔴 **Both agency verdict writers are gated on `kyc_details.status: 'pending'`, they are the only
two writers of that field, and nothing resets it.** So the first verdict of either kind is final:
`POST /agencies/:agencyId/verify` and `POST /agencies/:agencyId/reject` both answer `409` for ever
afterwards.

```
markVerifiedIfPending  { _id, 'kyc_details.status': 'pending' } → 'verified'
rejectIfPending        { _id, 'kyc_details.status': 'pending' } → 'rejected'
```

**Why we read it as an oversight rather than a decision:** the change moved the compare-and-set
from `status: 'pending_verification'` to the KYC axis, and documented *that* move carefully in the
filter's own comment. But `rejectIfPending`'s method header, six lines above it, still says:

> *"It also means re-review needs no 'un-reject': the agency is still pending, so
> `markVerifiedIfPending` accepts it once they fix what the reason names."*

That was true under the old predicate — rejection left `status` at `pending_verification`, so
verify still matched — and the axis move falsified it without the sentence being revisited.
`agencies.md` carries the same promise (*"There is deliberately no un-reject. The agency is still
pending, so `POST /verify` accepts them"*).

⚠ **A re-applying agency is the commonest row in this queue** — it is the reason this dashboard
reads `kyc.rejectionReason` at all. Under the new predicate they cannot be approved.

⚠ **Vendors are unaffected** — `VendorRepository.setKycVerdict` is a plain `findByIdAndUpdate` with
no predicate, so a rejected vendor re-verifies fine. The asymmetry is worth a look in its own
right.

**Secondary:** agencies whose document predates `kyc_details` have no `status` there at all, so the
filter misses them and their *first* review `409`s. The schema default (`status: 'pending'`) covers
newly created ones only.

**We have not worked around it.** The reject dialog still tells the agency they may reapply,
because that is the stated intent; inverting our copy to match a suspected bug would entrench it.

---

## § 3 — Three wi-admin pages now describe behaviour the service no longer has

Not blocking — we have corrected `src/` against jovi-mall source and noted the date at each site —
but these are the pages a future reader will reach for, and the fusion they describe is exactly
what the change exists to break.

| Page | Says | Since 2026-09-15 |
|---|---|---|
| `agencies.md` § `POST /agencies/:agencyId/verify` | **"This is the exit from `pending_verification`"**, and the response message *"Agency verified — it may now operate"* | `status` is **deliberately not written** by this route. An agency promotes itself on a proved phone plus a name |
| `agencies.md` § `POST /agencies/:agencyId/reject` | "The agency is still pending, so `POST /verify` accepts them" | See § 2 — it does not |
| `agencies.md` line 66 | `verified` is "**Distinct from `status`, and the two can legitimately disagree**" | ✅ **Still exactly right**, and now more so. Worth keeping verbatim |

⚠ **The conflict code's name is now misleading.** A verify/reject miss surfaces as
`PLATFORM_OPERATION_REJECTED` with `details.platformCode: "AGENCY_STATUS_CONFLICT"`, but the
compare-and-set no longer touches `status` — it is a *verdict* conflict. We branch on the constant,
so a rename costs us one line and we would rather take it than keep a name that points at the wrong
field. Your call.

**Also worth a line on `vendors.md` / `agencies.md` / `agents.md`:** that `status: "active"` is no
longer evidence of vetting. The three pages describe `status` without saying what it has stopped
meaning, and a dashboard is exactly where that inference gets made.

---

## What admin-dash changed on its own account, 2026-09-15

No behaviour — the backend is not deployed — but six sites asserted the old fusion and would have
taught it to the next reader:

- `components/agencies/AgencyStatusBadge.tsx` — dropped *"`POST /verify` is the exit"*
- `types/agencies.types.ts` — `AgencyStatus`'s doc no longer says `verify` moves
  `pending_verification → active`, and now states the two rules that follow from the split
- `services/agencies.service.ts` — the verify doc's *"exit from `pending_verification`"*, and the
  `409` table, whose **"or it was deactivated in between"** branch the axis move removed
- `services/agencies.service.ts` — the reject doc now carries § 2
- `components/verification/ReviewAgencyVerificationDialog.tsx` — the success toast
  (*"It may now operate"*) and the dialog description (*"Verifying is the exit from pending
  verification"*)

⚠ **Both operator-facing strings were rewritten to claim nothing about `status` in either
direction**, so they are true before and after the change ships.

✅ **Vendor and agent needed nothing.** `VendorStatusBadge` already separates the four axes and says
`pending_verification` blocks nothing; the agent's six trust signals are already independent and
already render `kycStatus ?? 'unverified'`, preserving the role's own word rather than flattening it
to `pending` — which is what the brief asks for.

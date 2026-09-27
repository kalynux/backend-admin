# Admin dashboard: COD deposits and remittances carry a proof photo

> **Date:** 2026-09-27 · **Audience:** the admin dashboard · **Breaking:** no. Every change here
> is additive
>
> The rule behind it, across every app:
> [jovi-mall/api-doc/FRONTEND-CHANGELOG-cod-cash-proof.md](../../jovi-mall/api-doc/FRONTEND-CHANGELOG-cod-cash-proof.md) ·
> Full contract: [api/cod.md](./api/cod.md)

Agents and agencies must now attach **one photo** (a receipt, a transfer screenshot, or the
hand-over itself) whenever they **declare** a COD cash hand-over. Two of those declarations land
on this dashboard to be answered:

- an **agency remittance** (agency → platform), which an administrator confirms or rejects;
- an agent's **`recipient: "platform"` deposit** (agent → platform, skipping the agency), which
  an administrator also confirms or rejects.

**The photo is what the operator checks before pressing Confirm.** The transfer reference, which
used to be that evidence, is now **optional** and will often be `null`.

| # | Change | Kind |
|---|---|---|
| 1 | `proof` on every remittance and deposit: in lists, in details, and in confirm/reject responses | additive |
| 2 | `proof` on the `deposit` joined into a discrepancy detail | additive |
| 3 | `reference` is `null` more often. Don't treat it as missing evidence | behaviour |
| — | `POST /api/v1/cod/deposits` (recording a direct deposit) | **unchanged**: `reference` still required, no photo |

No new endpoint and no new permission.

---

## 1 · The field

```json
"proof": {
  "id": "6682aabbccddeeff00112240",
  "key": "cod-proofs/2026/09/…webp",
  "url": null,
  "access": "authorized",
  "mimeType": "image/webp",
  "size": 184320,
  "originalName": "receipt.jpg"
}
```

It is an ordinary `FileDetail`, with the same shape `ShipmentProfilePanels` already receives for a
delivery proof. It appears on:

| Read | Where |
|---|---|
| `GET /api/v1/cod/remittances` · `/:remittanceId` | `data[].proof` · `data.proof` |
| `GET /api/v1/cod/deposits` · `/:depositId` | `data[].proof` · `data.proof` |
| `GET /api/v1/cod/discrepancies/:discrepancyId` | `data.deposit.proof` (when a deposit is joined) |
| `POST …/remittances/:id/{confirm,reject,triage}` | the returned remittance |

**`proof: null` is normal** for:

- a deposit recorded in **one step**, either by an agency at its desk or by an administrator
  through `POST /api/v1/cod/deposits` (neither has a declaration to prove);
- any declaration made **before 2026-09-27**.

Show "No photo attached". It is not an error and not a reason to reject.

---

## 2 · Showing it

`url` is always `null`, because `cod-proofs/` is a private folder. Use the existing
**`GET /api/v1/files/:fileId/content`** (`files.content.read`, held by all three tiers, audited),
which is exactly what `FileViewer` does:

```tsx
{row.proof ? <FileViewer key={row.proof.id} file={row.proof} /> : <NoProof />}
```

- ⚠ **Keep `FileViewer`'s on-demand fetch.** Every open writes an audit row, so don't fetch on
  mount and don't preload thumbnails into a list. On a list, show a "Photo" indicator and open
  the photo on the detail screen or on click.
- `key={row.proof.id}` is required. `FileViewer` changes files by remounting, as its header
  explains.

### Where it belongs

| Screen | Put the photo |
|---|---|
| `src/pages/cod/RemittanceDetail.tsx` | Next to the Confirm / Reject actions, above the fold |
| `src/pages/cod/DepositDetail.tsx` | Same, for a declared `platform` deposit. For an `agency` deposit it is read-only context (the agency answers those) |
| `src/pages/cod/RemittancesModule.tsx` / `DepositsModule.tsx` | A "has photo" icon column, no fetch |
| The discrepancy detail | Under the joined deposit: often the evidence the dispute is about |

Types: add `proof: FileDetail | null` to `Remittance` and `Deposit` in `src/types/cod.types.ts`.
The detail types and the discrepancy's `deposit` inherit it.

---

## 3 · `reference` is optional now

Since the photo became the required evidence, agents and agencies may leave the reference empty.
Expect `reference: null` on new remittances and deposits:

- Render "—", and keep the table search null-safe.
- Don't show a warning or badge for a missing reference. The photo is the evidence.
- The **Record deposit** dialog (`RecordDepositDialog.tsx`) is **unchanged**. Its `reference` is
  still required, because an administrator recording cash directly has no photo to attach.

---

## Checklist

- [ ] `Remittance` and `Deposit` gain `proof: FileDetail | null`
- [ ] The remittance and deposit details show the photo through `FileViewer`, fetched on demand
- [ ] The discrepancy detail shows the joined deposit's photo
- [ ] The lists show a "has photo" indicator without fetching
- [ ] `reference: null` renders as "—" and is never flagged as missing

# `/geo` — address search

**Built 2026-09-14 (ADR-023).** Turning what somebody typed into an address you can store.

Base path: `/api/v1/geo`

| Method | Path | Permission | Reachable while `pending` | Audited |
|---|---|---|---|---|
| `GET` | `/geo/search` | *self* | ✅ | — |
| `GET` | `/geo/reverse` | *self* | ✅ | — |

**No permission**, and that is a decision rather than an oversight. These routes act on no
identity at all: they read a public gazetteer through a third-party geocoder and touch no
platform data, no administrator record and no person. There is no subject to grade by, so a
permission would have to be invented — and an invented permission is one somebody later grants
to a tier for the wrong reason. Every authenticated administrator can call them, including one
who has not been activated yet (they cannot finish their employee record otherwise).

**Not audited.** A read is audited on this service only when the disclosure *is* the action, and
the one standing exception is a payout destination. What gets recorded is the address an
administrator actually **stores**, by the audited write that stores it.

---

## The workflow — two calls, and the second one is not here

This is the platform's standard address-entry pattern and every role uses it:

1. **`GET /geo/search?q=…`** — the user types, you get ranked candidates.
2. The user picks one. You show them the `formatted_address`.
3. **You post the chosen candidate back, verbatim**, to whichever record is being edited —
   today that is `homeAddress` on [`PATCH /employees/me`](employees.md).

**⚠ Send the candidate unchanged.** Do not rebuild it, do not drop fields you think are unused,
and do not hand-assemble one from a text box and a pair of coordinates. The stored row records
*which provider resolved it* and carries a `provider_place_id` that can be looked up later —
that is what makes a stored address verifiable rather than merely plausible. A hand-built object
will pass validation and be worth nothing.

`resolved_at` is stamped server-side; any value you send for it is ignored.

---

## `GET /geo/search`

### Query parameters

| Name | | |
|---|---|---|
| `q` | **required** | Free-form text, 1–300 characters |
| `limit` | optional | 1–20. The provider applies its own default when omitted |
| `country` | optional | Comma-separated ISO-3166-1 alpha-2 codes to bias results, e.g. `cm,ng` |
| `lang` | optional | BCP-47 preferred result language, e.g. `fr` |

### Response (200)

```jsonc
{
  "success": true,
  "requestId": "…",
  "data": {
    "provider": "chain",               // ⚠ may name the CHAIN, not the resolver
    "query": "bonapriso douala",
    "results": [
      {
        "formatted_address": "Bonapriso, Douala, Littoral, Cameroon",
        "coordinates": { "type": "Point", "coordinates": [9.7043, 4.0341] },
        "provider": "geoapify",        // ⚠ THIS is the one that gets stored
        "provider_place_id": "51f0…",
        "components": {
          "street": null,
          "neighbourhood": "Bonapriso",
          "city": "Douala",
          "region": "Littoral",
          "country": "Cameroon",
          "country_code": "CM",
          "postal_code": null
        },
        "raw_input": null
      }
    ]
  }
}
```

**⚠ `coordinates` is GeoJSON: `[longitude, latitude]`, in that order.** It is the usual mistake
and it puts Douala in the Atlantic.

**⚠ There are two `provider` fields and they are not the same thing.** The one at the top of
`data` describes the configured setup and may read `chain`. The one on each candidate names the
service that actually resolved *that* result, and it is the one stored — a row saying "chain"
would name the plumbing and lose the fact.

**⚠ Every `components` part is nullable.** Provider coverage varies and rural Cameroon rarely
has a postal code. Render around the nulls; do not require a city.

**`results` can legitimately be empty.** That is "no match", not an error.

---

## `GET /geo/reverse`

### Query parameters

| Name | | |
|---|---|---|
| `lat` | **required** | −90 … 90 |
| `lng` | **required** | −180 … 180 |

### Response (200)

```jsonc
{
  "success": true,
  "data": {
    "provider": "chain",
    "result": { /* one candidate, same shape as above */ }
  }
}
```

**⚠ `result` may be `null`.** A coordinate in the middle of nowhere has no address, and that is
an answer rather than a failure. Render the null case; do not treat it as an error.

---

## Where this actually runs, and what it costs

wi-admin has **no geocoder**. Both routes are delegated to jovi-mall, which owns the provider
chain, the API keys and the cache.

The reason is not tidiness. jovi-mall's own `/api/geo` mount resolves a platform `users` row,
which an administrator does not have — so until this was built, the platform's geocoder was
reachable by every role *except* the one staffing it. Giving wi-admin its own provider key
instead would have put a **second spender on one free-tier quota** with nothing anywhere adding
the two together, so a burst on one side would exhaust the allowance the other depends on and
the symptom would land in a different service from the cause.

One geocoder, one chain, one quota, one place to change the provider.

**There is no cache on this side.** jovi-mall's geocoding layer already has one, and a second
cache in front of it would serve stale candidates with a `provider_place_id` the first had
already replaced.

### Errors

| Code | Status | |
|---|---|---|
| `VALIDATION_ERROR` | 400 | A missing `q`, or coordinates out of range |
| `SERVICE_DEPENDENCY_UNAVAILABLE` | 503 | jovi-mall is not configured (`JOVI_MALL_BASE_URL`) |
| `PLATFORM_OPERATION_REJECTED` | varies | The provider refused or is unavailable |

---

## Related

- [`employees.md`](employees.md) — the one record that stores a `GeoAddress` today
- [`errors.md`](errors.md) — the envelope and the categories

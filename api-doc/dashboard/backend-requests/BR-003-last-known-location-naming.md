# BR-003 · Naming an agent's last-known position

**Verified against source on 2026-09-08** — the `lastKnown` block and the four tracking reads
against the live route manifest and [`agents.md`](../../api/agents.md); the *"no data door"* claim
below against `admin/src/modules/agents/domain/tracking-disclosure.ts` and
`admin/docs/ADR-020-ADMIN-DATA-DOOR.md`; and the absence of any accuracy field against
geo-tracker's location domain.

> ### ✅ BUILT — except `accuracyMetres`, which is **not deliverable** and never will be `null`-shipped
>
> **Answered in [`RESPONSE-2026-08-17.md`](RESPONSE-2026-08-17.md); live contract
> [`agents.md`](../../api/agents.md).** `lastKnown.place` shipped in exactly the proposed shape
> (`label` · open `source` string · `resolvedAt`, `null` when unresolved), resolved server-side once
> per position. Three repositories changed to make it answerable at all — the notification pipe had
> never carried a coordinate. The exposure question in § 3 was answered: **`lastKnown` stays under
> `agents.read`**, no new permission and no audit row.
>
> ⛔ **The "What exists today" table is wrong on two rows, and has been since 2026-08-22.** It says
> a live position and a trail are *"**No.** wi-admin has no data door into geo-tracker"*. **Phase
> 6.I built that door** ([ADR-020](../../../docs/ADR-020-ADMIN-DATA-DOOR.md)) — four scoped reads:
> `GET /agents/:agentId/live-position` (audited, fail-closed) and `/tracking-presence`,
> `GET /shipments/:shipmentId/tracking-trail` and `/tracking-events`. § 4's *"if a genuinely live
> view is wanted it is a separate, larger piece of work"* is right, and that work **happened**.
>
> The `lastKnown` warning itself still stands and still matters: it is a **stale business mirror**,
> not a live position, and must be rendered as "last seen". The live answer is the new read.

**Priority: medium.** Carries an open question from
[`DATA-EXPOSURE-REGISTER.md` §1](../DATA-EXPOSURE-REGISTER.md) that should be answered at the same time.

## The ask

> On the agents directory, under the Tracking tab, at the level of last-known position, we should be
> able to open the long and lat on a real map (Google Maps — just to be able to actually see the
> location live) and give it a name.

## What exists today

`GET /api/v1/agents/:agentId` returns, under plain `agents.read`:

```jsonc
"lastKnown": {
  "status": "tracking",
  "position": { "type": "Point", "coordinates": [9.7043, 4.0511] },
  "reportedAt": "2026-08-13T08:41:12.000Z",
  "source": "geo-tracker",
  "isStale": true
}
```

**Five fields. That is all of it.**

| Asked for | Present? |
|---|---|
| Coordinates | Yes — GeoJSON `[longitude, latitude]`, **in that order** |
| A place name / address | **No field anywhere in the service** |
| Accuracy | **No field** |
| A live position | **No.** [`agents.md`](../../api/agents.md): *"wi-admin has no data door into geo-tracker"*; [`system.md`](../../api/system.md): *"Live agent positions or GPS trails → geo-tracker, behind Tracking Allow. **No door exists from this service.**"* |
| A trail / history | **No** |

`GET /agents/:agentId/tracking-policy` returns the *verdict* (`trackingAllowed` + `denyReason`), not a
position. `homeBase` is *"label and radius only"* — the geographic point is deliberately not projected,
because it is a person's residence.

`agents.md`'s own warning is worth quoting in full, because it constrains what the dashboard was
willing to build:

> `position` is written by geo-tracker's **best-effort** notifier. No assignment rule reads it, and
> **serving it as a live position is a bug.** `isStale` is `true` when the report is older than two
> minutes. **Render this as "last seen", never as a live marker on a map.** A live marker would
> simply stop moving and nobody would be told.

## What the dashboard does in the meantime

The panel keeps refusing an **embedded** map, and that refusal stands — a static pin implies liveness
the data does not have. What ships instead:

- The freshness badge, `reportedAt` and the relative age sit **above** the coordinates and are shown
  without revealing anything, so an operator can tell the record is four hours old before deciding to
  look at it.
- The coordinates stay behind an explicit reveal, the way a payout destination is revealed rather
  than printed.
- After the reveal, an **"Open in Google Maps"** link (`target="_blank"`, `rel="noreferrer noopener"`)
  hands the coordinates to a third party in a URL. That is a new disclosure and it is an act the
  operator chooses, after reading the staleness — not something the page does on load.
- The GeoJSON `[lng, lat]` → Google's `lat,lng` inversion is a named, unit-tested helper. Getting it
  wrong drops the pin in the wrong hemisphere and fails silently.

**Naming the location is not possible client-side.** There is no address on the payload and no
geocoder in this application. So it is here.

## The proposed contract

### 1. A resolved label on `lastKnown`

```jsonc
"lastKnown": {
  …,
  "place": {
    "label": "Bonapriso, Douala",
    "source": "reverse_geocode",
    "resolvedAt": "2026-08-13T08:41:14.000Z"
  }
}
```

- `place: null` when nothing resolved — never `""`, never a coordinate string dressed up as a name.
- `source` is an open string, so a future *"nearest landmark"* or *"agency coverage region"*
  resolution is additive. The dashboard renders it raw and does not `switch`.
- **Resolve it server-side, cached.** Reverse geocoding per browser per render is a per-seat API bill
  and leaks a person's coordinates to a geocoding provider once per operator who opens the tab,
  rather than once per position.
- Because it is derived from the position, it inherits the position's exposure question below.

### 2. `accuracy`

```jsonc
"position": { "type": "Point", "coordinates": [9.7043, 4.0511], "accuracyMetres": 65 }
```

geo-tracker has this at collection time. Without it, a 5 km GSM-triangulated fix and a 5 m GPS fix
render identically, and an operator makes a dispatch decision on the difference.

`null` when the source did not report one.

### 3. The standing exposure question — please answer it here

[`DATA-EXPOSURE-REGISTER.md` §1](../DATA-EXPOSURE-REGISTER.md) flags that `lastKnown.position` ships:

- regardless of `tracking.allowed`;
- regardless of the `/tracking-policy` verdict, **including `no_approved_agency`**, whose own
  documentation says *"nobody is entitled to watch an unaffiliated person move around"*;
- with no permission of its own, so **tier-3 Support** receives a person's coordinates while
  answering an unrelated delivery ticket;
- with **no audit row**, unlike `GET /money/payouts/:payoutId/destination`, which is the service's one
  audited read precisely because *the disclosure is the action*.

Adding a resolved place name makes the payload materially more legible — *"Bonapriso, Douala"* is a
disclosure in a way `[9.7043, 4.0511]` is not, because it needs no tool to read. So the gating
decision should be taken **with** this change, not after it.

Our reading, offered as a starting point rather than a demand: move the whole `lastKnown` block behind
its own permission (`agents.tracking.read`, not held by tier 3), and make reading it an audited
disclosure on the payout-destination model.

### 4. What is *not* being asked for

A live position, or a door into geo-tracker. The operator's word was *"live"*, but the honest answer
is that this data is a stale business mirror and the dashboard says so on screen. If a genuinely live
view is wanted it is a separate, larger piece of work — a wi-admin → geo-tracker read path, gated on
Tracking Allow, and it should be its own request.

## Acceptance

- [ ] `lastKnown.place` is present, `null` when unresolved, with an open `source` string.
- [ ] Resolution happens server-side and is cached against the position, not per request.
- [ ] `position.accuracyMetres` is present, `null` when the source reported none.
- [ ] `agents.md` documents both, including that coordinates remain `[lng, lat]`.
- [ ] A decision is recorded on gating and auditing the `lastKnown` block, and
      `DATA-EXPOSURE-REGISTER.md` §1 is updated with it.

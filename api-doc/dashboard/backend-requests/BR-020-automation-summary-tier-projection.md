# BR-020 · `/automation/summary` discloses to Support exactly what `/automation/failures` withholds from them

**Raised 2026-09-09, from building the `/automation` module.** Checked against
[`automation.md`](../../api/automation.md) (the projection table at `:94-100`, the summary section
at `:102-127`) and [`ADR-022`](../../../docs/ADR-022-AUTOMATION-FAILURE-AUDIT.md) D-7's rung table
at `:205-209`. **Nothing here is a bug report about behaviour** — the two routes do what their
pages say. The disagreement is between the two pages.

**Priority: low, and deliberately raised before it matters.** No operator has been harmed. We are
asking because the dashboard has had to *depend* on the current shape, and if the shape is an
oversight rather than a decision, our dependency is the thing that breaks.

---

## The disagreement

`GET /automation/failures` is tier-projected, and the boundary it draws is explicit:

| Field group | 1 Developer | 2 Admin | 3 Support |
|---|:--:|:--:|:--:|
| `kind`, `occurredAt`, `channel` | ✅ | ✅ | ✅ |
| workflow, node, `errorMessage`, `executionId` | ✅ | ✅ | **—** |
| `errorStack`, `requestId` | ✅ | — | — |

ADR-022 D-7 states the same intent in prose: Support sees *"that a channel is degraded, and
when"*. Not which workflow.

`GET /automation/summary` then says:

> Query: `windowHours` (1–720, default 24). **Not tier-projected — a count carries no machine
> detail and no identifier, so there is nothing to withhold.**

**But its own worked example carries machine detail**, in the two fields the feed is careful to
withhold:

```jsonc
"groups": [
  {
    "workflowId": "vvbouV2136P5weCs",     // ← withheld from Support on /failures
    "workflowName": "UP-wi-mall-core",     // ← withheld from Support on /failures
    "kind": "degraded_turn",
    "channel": "whatsapp",
    "count": 47,
    "distinctCustomers": 12,
    "lastOccurredAt": "2026-09-07T11:12:31.874Z"
  }
]
```

Both routes carry the **same** `any`-mode guard, so any caller who can read one can read the
other. A tier-3 administrator holding `support.automation.lookup` is therefore refused
`workflowName` on the feed and handed it on the summary, one click away.

**We are not asking about `distinctCustomers`.** D-5 is unambiguous that the digest is never
emitted and that the count is computed server-side; a count of distinct customers is not an
identifier and we are not treating it as one.

---

## Why we are asking rather than just rendering it

Two reasons, and the second is the real one.

**First, the justification sentence is checkable and false.** *"A count carries no machine detail
and no identifier"* is true of `count` and `lastOccurredAt` and not true of the object they sit
in. A reader who takes that sentence at face value — as we nearly did — concludes the summary is
safe to show anyone, without noticing it is the one place a workflow identity crosses the tier-3
boundary.

**Second, we have built a decision on top of it.** The `/automation` module has two children and
no index child, so each tier lands on its first permitted one. **We made Summary first,
deliberately, *because* it is ungraded** — landing a Support administrator on the failures feed
lands them on a three-field row, which is the thinnest thing in the module. That is a good call if
the current shape is intended, and the wrong call if it is not.

If you tier-project the summary later, our nav decision inverts and a Support administrator's
landing screen silently becomes emptier than the one beside it. We would rather change it now, on
purpose, than discover it from a deploy.

---

## Asking for one of

| | What you would change | What we would change |
|---|---|---|
| **(a) It is intended** — workflow identity in *aggregate* is not the same disclosure as workflow identity *per incident*, and Support may see it | **Correct the sentence** at `automation.md:104`. It should say the summary is ungraded and *why that is safe*, rather than claiming it carries no machine detail. A line in D-7 noting that the rung table describes `/failures` only | Nothing. We keep Summary as the landing child and record your answer beside the nav decision |
| **(b) It is an oversight** — the D-7 boundary was meant to hold across the module | Project the summary the way the feed is projected: withhold `workflowId` and `workflowName` from tier 3, leaving `kind`, `channel`, `count`, `lastOccurredAt` | Reverse the landing child so tier 3 lands on the feed, and drop the "Support sees more here" note from `navigation.ts` |

**(a) is our guess**, for what it is worth — aggregate identity really is a weaker disclosure than
per-incident identity, and the summary carries no node, no message and no stack. But that is a
judgement about *your* boundary, which is why we are not making it for you.

---

## What we have shipped meanwhile

The module renders what each route returns and adds nothing. Specifically:

- the failures feed narrows on the **row's shape**, never on the caller's tier, so a change to the
  projection needs no client change;
- the summary is rendered whole;
- `view` is surfaced as standing copy on the feed, so a Support reader is told that what they are
  seeing is the complete answer at their level rather than a truncated one — and, given the
  asymmetry above, that the summary beside it is wider.

Whichever way this goes, nothing needs to be undone first.

---

## Confirmed on the wire — 2026-09-09

**Added after Phase 6 live verification against a running `:8033`.** Everything above was written
from the two pages. This section is what the service actually does, so this request is no longer
*"the docs disagree"* but *"the docs disagree, and here is the behaviour"* — which is the version
you can act on. Method and full transcript in
[VERIFICATION-2026-09-09-LIVE](../../../VERIFICATION-2026-09-09-LIVE.md) § 3 and § 8.

Five failure reports were seeded through the real reporter door
(`POST /api/internal/automation/failures`, `x-automation-token`) and both read routes were called
with three throwaway administrator sessions, one per tier.

### `GET /automation/failures` — projected exactly as documented

| Tier | `view` | Fields on a row |
|---:|---|---|
| 1 | `developer` | `id · kind · occurredAt · channel · workflowId · workflowName · executionId · nodeName · errorMessage · receivedAt · errorStack · requestId` (12) |
| 2 | `admin` | the same minus `errorStack` and `requestId` (10) |
| 3 | `support` | `id · kind · occurredAt · channel` (4) |

`configured: true` present at all three. `externalIdHash` absent at all three — D-5 holds.

### `GET /automation/summary` — **not projected, at all**

Byte-identical `groups` at all three tiers, and **no `view` field on any of them**. The tier-3
response, verbatim, from an account holding `support.automation.lookup` and nothing else
(31 permissions, no `system.automation.read`, no `developer_tools.logs.read`):

```json
{
  "success": true,
  "data": {
    "configured": true,
    "windowHours": 24,
    "since": "2026-09-08T19:55:27.366Z",
    "groups": [
      {
        "workflowId": "wf-tg-adapter-001",
        "workflowName": "UP-wi-mall-tg-adapter",
        "kind": "execution_failed",
        "channel": "unknown",
        "count": 2,
        "distinctCustomers": 1,
        "lastOccurredAt": "2026-09-09T19:45:17.714Z"
      },
      {
        "workflowId": "wf-product-cards-003",
        "workflowName": "wi-mall-product-cards",
        "kind": "execution_failed",
        "channel": "telegram",
        "count": 1,
        "distinctCustomers": 0,
        "lastOccurredAt": "2026-09-09T19:49:17.714Z"
      },
      {
        "workflowId": "wf-wa-adapter-002",
        "workflowName": "UP-wi-mall-wa-adapter",
        "kind": "degraded_turn",
        "channel": "whatsapp",
        "count": 1,
        "distinctCustomers": 1,
        "lastOccurredAt": "2026-09-09T19:47:17.714Z"
      },
      {
        "workflowId": "wf-tg-adapter-001",
        "workflowName": "UP-wi-mall-tg-adapter",
        "kind": "degraded_turn",
        "channel": "telegram",
        "count": 1,
        "distinctCustomers": 1,
        "lastOccurredAt": "2026-09-09T19:46:17.714Z"
      }
    ]
  }
}
```

**So the asymmetry is real and it is exactly as described above**, not larger and not smaller: the
tier-3 caller is refused `workflowId` and `workflowName` on the feed and handed both on the
summary, one request away, with the same guard. `AutomationController.summary` never reads
`admin.tier` — it is the only route in the module that does not.

### Two details worth recording while you decide

- **`distinctCustomers` behaves precisely as D-5 describes**, which we mention because it is the
  field we said we were *not* asking about and it deserves the confirmation: a report with
  `externalId: null` contributed `distinctCustomers: 0` against `count: 1`, and two reports sharing
  one `externalId` gave `distinctCustomers: 1` against `count: 2`. The null hash is filtered, not
  counted as a customer.
- **`channel: "unknown"` is not a rare case.** Both `execution_failed` rows that carried no
  envelope landed as `unknown` — the stored default — so on this sample the *only* rows with no
  channel were the died-outright ones. `?channel=unknown` returned them; a Telegram/WhatsApp-only
  filter would have hidden both. That was an argument in the plan and it is now a measurement.

**Our position is unchanged**, including that **(a) is our guess**. Nothing above tells us which of
(a) or (b) you intend — only that whichever you pick, the behaviour it applies to is the behaviour
described here.

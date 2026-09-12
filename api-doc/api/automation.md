# `/automation` — what the customer bot reported about its own failures

**Verified against source on 2026-09-09** — both routes, their three-permission `any` guard, the two enums, the query bounds and the tier projection, against `admin/src/modules/automation/{routes,validators,domain,controllers,repositories}/`. This round re-checked the **summary's** shape specifically, which the previous pass took the prose's word for: it is ungraded, it does emit `workflowId` and `workflowName` to tier 3, and the sentence that said otherwise is corrected below (BR-020).

Base path: `/api/v1/automation`

What an operator needs to answer *"is the customer bot working?"* — a question `/system` cannot
answer, because `/system` reports on **this platform's** machinery and the bot runs on a
third-party runtime (n8n) that fails independently of it.

**Both routes are `GET` and neither is audited.** The subject is a machine; nothing here discloses
anything about a person.

Design record: [`../../docs/ADR-022-AUTOMATION-FAILURE-AUDIT.md`](../../docs/ADR-022-AUTOMATION-FAILURE-AUDIT.md)

| Method | Path | Permission |
|---|---|---|
| `GET` | `/automation/failures` | **any of** `developer_tools.logs.read`, `system.automation.read`, `support.automation.lookup` |
| `GET` | `/automation/summary` | same three |

---

## ⚠ Read this before building a screen on it

**A successful n8n execution can still be a failure.** The bot's workflows carry fifteen
error-swallowing nodes, deliberately, so that a customer always gets *an* answer. On 2026-09-07
jovi-mall was down, a customer got the "cannot reach the service" fallback, and n8n recorded the
execution as `success`.

So this surface reports two different things and a dashboard should not merge them:

| `kind` | Means | Typical cause |
|---|---|---|
| `execution_failed` | the workflow **died** | a send was refused, a node threw |
| `degraded_turn` | the workflow **succeeded** and the answer was worse than it should have been | jovi-mall unreachable, the model did not answer |

A wall of `degraded_turn` with no `execution_failed` is the signature of *something else* being
down — usually jovi-mall. A wall of `execution_failed` is the bot itself.

---

## `GET /automation/failures`

| Query parameter | Type | Default | Bounds |
|---|---|---|---|
| `workflowId` | string | — | 1–64 characters. The **id**, never the name |
| `kind` | enum | — | `execution_failed` · `degraded_turn` |
| `channel` | enum | — | `telegram` · `whatsapp` · **`unknown`** |
| `windowHours` | integer | `24` | 1 – 720 (30 days) |
| `limit` | integer | `50` | 1 – 200 |

Anything outside those bounds is a `400 VALIDATION_ERROR`. There is **no cursor and no `meta`** —
this is a monitoring surface, not an export, and the rows expire.

⚠ **`channel: "unknown"` is a real value and a filter must offer it.** It is the stored default,
and an `execution_failed` report has no envelope to read a channel out of — so a dropdown offering
only Telegram and WhatsApp hides most of the *died-outright* rows, which are the more urgent half.

**The response is graded by the caller's tier**, and `view` names which grading you got. That
field is not decoration: without it a Support agent reading a two-field row cannot tell *"there is
nothing more to know"* from *"I am not being shown it"*, and escalates an incident that is already
understood.

```jsonc
{
  "success": true,
  "data": {
    "configured": true,          // false ⇒ no reporter points here; see below
    "windowHours": 24,
    "count": 2,
    "view": "admin",             // developer | admin | support
    "entries": [
      {
        "id": "65f0…",
        "kind": "degraded_turn",
        "occurredAt": "2026-09-07T11:12:31.874Z",
        "channel": "whatsapp",
        // tier 2 and 1 only, from here down
        "workflowId": "vvbouV2136P5weCs",
        "workflowName": "UP-wi-mall-core",
        "executionId": "902",
        "nodeName": "sync identity",
        "errorMessage": "timeout of 20000ms exceeded",
        "receivedAt": "2026-09-07T11:12:33.000Z",
        // tier 1 only
        "errorStack": "AxiosError: …",
        "requestId": "902"
      }
    ]
  }
}
```

| Field group | 1 Developer | 2 Admin | 3 Support |
|---|:--:|:--:|:--:|
| `kind`, `occurredAt`, `channel` | ✅ | ✅ | ✅ |
| workflow, node, `errorMessage`, `executionId` | ✅ | ✅ | — |
| `errorStack`, `requestId` | ✅ | — | — |

**No tier ever receives the customer identifier**, hashed or otherwise. See ADR-022 D-5.

⚠ **This table describes `/failures` and only `/failures`.** The summary below is ungraded and
**does** hand tier 3 a workflow identity. That is deliberate; the reason is under it.

## `GET /automation/summary`

Query: `windowHours` (1–720, default 24).

**Not tier-projected.** ⚠ **This said "a count carries no machine detail and no identifier, so
there is nothing to withhold", and that was checkable and false** (BR-020, corrected 2026-09-09):
true of `count` and `lastOccurredAt`, not true of the object they sit in, which carries
`workflowId` and `workflowName` — the two fields the feed above is careful to withhold from tier 3.
Both routes carry the same `any`-mode guard, so a Support administrator is refused a workflow name
on the feed and handed it here, one click away.

**The asymmetry is intended, and the reason is what the tier-3 boundary is actually for.** It is
not confidentiality — ADR-022 D-7 says what Support is denied is machine detail *"which on a
support call is not a secret so much as a false lead"*. That hazard is **per-incident causal
attribution**: an agent reading one row and telling a customer their message failed because the
`sync identity` node timed out. A summary cannot produce that sentence. It has no node, no
message, no stack and no per-incident row — only *this workflow, this channel, this many, since
then*. **Aggregate identity is a weaker disclosure than per-incident identity**, and the statement
it supports — *"WhatsApp is degraded right now, we know"* — is precisely the one D-7 grants
Support this surface in order to make.

So the rule across the module is: **the feed is graded, the summary is whole.** A client renders
the summary as it arrives at every tier.

⚠ **`workflowId` is also an ungated query *filter* on `/failures`** — `FailureQuerySchema` does not
consult the caller's tier. Tier 3 can therefore narrow the feed by a workflow id, and still gets
tier-3 rows back. Consistent with the above, and named here so it is not later mistaken for a leak.

```jsonc
{
  "success": true,
  "data": {
    "configured": true,
    "windowHours": 24,
    "since": "2026-09-06T11:00:00.000Z",
    "groups": [
      {
        "workflowId": "vvbouV2136P5weCs",
        "workflowName": "UP-wi-mall-core",
        "kind": "degraded_turn",
        "channel": "whatsapp",
        "count": 47,
        "distinctCustomers": 12,   // computed server-side from a hash never emitted
        "lastOccurredAt": "2026-09-07T11:12:31.874Z"
      }
    ]
  }
}
```

`distinctCustomers` is the one thing worth reading twice: **47 reports from 12 customers** is a
platform incident, **47 from 1** is one person retrying. A list cannot tell you which.

---

## ⚠ `configured: false` — and why an empty board is ambiguous without it

When `AUTOMATION_REPORT_TOKEN` is unset this deployment accepts no reports, and both routes answer
`configured: false` with nothing in them.

**An empty result means one of two opposite things** — *nothing failed*, or *no reporter is
pointed at this deployment* — and an operator looking at a clean board needs to know which.
Surface it in the UI; do not render an empty list as "all healthy".

## Coverage is an allowlist

Only workflows with `UP-wi-mall-failure-reporter` set as their `errorWorkflow` report at all — nine
today (ADR-022 D-8). **A new bot workflow is invisible until somebody wires it.** If a workflow you
expect to see never appears, check that before concluding it is healthy.

## Naming — match on `workflowId`, never `workflowName`

Every workflow belonging to this backend is named `UP-wi-mall-…` on the instance, which is why the
examples above read `UP-wi-mall-core`. **Do not key a filter, a label map or a dashboard route off
that string.** It is a display name a human can change in one click, and it has already changed
twice: `tg-adapter` → `wi-mall-tg-adapter` → `UP-wi-mall-tg-adapter`, both on 2026-09-07.

`workflowId` is the stable identifier and did not change through either rename. The
`?workflowId=` query filter takes the id, not the name.

# `/automation` — what the customer bot reported about its own failures

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

Query: `workflowId`, `kind`, `channel`, `windowHours` (1–720, default 24), `limit` (1–200,
default 50). No cursor — this is a monitoring surface, not an export, and the rows expire.

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
        "workflowName": "wi-mall-core",
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

## `GET /automation/summary`

Query: `windowHours` (1–720, default 24). Not tier-projected — a count carries no machine detail
and no identifier, so there is nothing to withhold.

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
        "workflowName": "wi-mall-core",
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

Only workflows with `wi-mall-failure-reporter` set as their `errorWorkflow` report at all — nine
today (ADR-022 D-8). **A new bot workflow is invisible until somebody wires it.** If a workflow you
expect to see never appears, check that before concluding it is healthy.

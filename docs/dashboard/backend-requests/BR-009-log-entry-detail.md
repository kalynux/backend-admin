# BR-009 · Detail for the two free-form log feeds

**Priority: low.** Most of this ask turned out to be a frontend gap. Two small backend items remain.

## The ask

> In the log section, we should be able to select the log and see the full detail of the log.

Read against all three log surfaces the dashboard has.

## What exists today, feed by feed

### Audit → Trail — **already complete. Nothing to do.**

`GET /api/v1/audit/:auditId` exists and returns every list field plus the four the list omits:
`payload` (*"with credential-shaped fields redacted by name"*), `before`, `after` and
`stateTruncated`. The dashboard already links every row to it and already renders all of it.

Recorded here only so nobody builds it twice.

### Audit → Legacy feed — no detail route, but the data is already in hand

`GET /api/v1/audit/legacy` returns rows whose shape is **deliberately not** `AuditEntryDto` — no
catalogued action, no `subjectClass`, no `sensitive`, and an actor from a separate identity space:

```jsonc
{ "id", "occurredAt", "correlationId", "source", "kind",
  "actor": { "kind": "platform_admin", "label", "userId", "role", "name", "ip", "userAgent" },
  "request": { "method", "path", "statusCode", "durationMs" },
  "action", "resource": { "type", "id" }, "params", "query", "bodyKeys", "changes" }
```

**There is no `GET /audit/legacy/:id`**, and the module is scheduled for deletion at cutover.

The dashboard's table renders about half of that. `correlationId`, `params`, `query`, `kind`,
`actor.ip`, `actor.userAgent` and the unabridged `changes` were all being fetched and thrown away —
which is a frontend gap, now fixed by expanding the row rather than fetching anything.

### Dev tools → Logs — the same, more so

`GET /api/v1/dev-tools/logs` returns entries typed `Record<string, unknown>` — free-form pino lines.
The dashboard rendered exactly four keys: `level`, `at`, `requestId`, `msg`. For a structured log
line that discards most of it (`err.stack`, `res.statusCode`, every context field). Also fixed by
expanding the row.

Paging here is cursor-based off `nextBefore`, correctly — the collection is capped and evicts from the
front, so an offset would yield duplicates and gaps.

## What the dashboard does in the meantime

Expandable row detail on both feeds. No new route and no drawer: neither has a fetchable resource
behind it, so expanding a row to show more of *that same row* is not a detail view — it is the row.

Both render through the existing untrusted-metadata renderer, which redacts a second time on the way
out, **names what it hid** rather than dropping it silently, and emits text nodes only — never
`dangerouslySetInnerHTML`, never a log value interpolated into an attribute or a URL.

The platform-log expansion feeds through the **same** credential scrubber pass the summary line uses,
so the page-level "N lines masked" tally stays true and unscrubbed credential shapes cannot appear in
the fields the summary never showed. The tier-1 warning banner stays visible above the expanded state.

`actor.userId` on a legacy row is **never linked** into `/dashboard/administrators` — a
`platform_admin` is not a wi-admin administrator, there is no mapping between the two identity spaces,
and `actor.label` is rendered server-side precisely so a client cannot present these as one of ours.

## The proposed contract

### 1. `GET /api/v1/audit/legacy/:id` — or a recorded decision not to

Permission `audit.read`, behind the same `audit.legacy_feed` feature flag, `404
AUDIT_LEGACY_FEED_DISABLED` when off.

**We are not sure this is worth building**, and would rather have the decision than the endpoint. The
module is deleted at cutover, the row already carries everything the writer stored, and the only thing
a detail route adds is addressability — the ability to link a colleague to one row.

If the answer is no, put a line in [`audit.md`](../../admin/api/audit.md) saying the legacy feed is
list-only by design. That is genuinely all we need; the absence currently reads as an omission.

### 2. A declared shape for platform log entries

This one we do want.

`GET /dev-tools/logs` entries are `Record<string, unknown>` on the wire and in
[`dev-tools.md`](../../admin/api/dev-tools.md). A reader is guessing which keys exist, and a client
cannot tell a missing field from a renamed one.

A **partial** declaration is enough — the point is not to close the shape, which would defeat a log:

```jsonc
{
  "at": "2026-08-17T09:12:04.000Z",   // always
  "level": "error",                    // always — and note it is at-or-above on the filter
  "msg": "…",                          // always
  "requestId": "…" | null,
  "err": { "type", "message", "stack" } | undefined,
  "res": { "statusCode": 500 } | undefined,
  "…": "any further keys the writer attached"
}
```

Documented as *"these keys are guaranteed; anything else is the writer's context and is rendered
raw."* That is the same posture the contract already takes on unknown enum members and it is the right
one here.

### 3. Two things worth confirming while you are in there

- **Is any field truncated on the wire?** The audit detail has `stateTruncated` for exactly this. If a
  long `err.stack` or a large context object is cut server-side, an expansion that shows it needs to
  say so — otherwise an operator reads a truncated stack as a complete one.
- **The `meta.warning` on this endpoint is load-bearing.** It states that log lines carry personal
  data — an email in an SMTP failure, a phone number in a send error — and that the scrubber removes
  credential *shapes* only. Expanding a row shows strictly more of that. Please keep the warning on
  the response rather than moving it to prose; the dashboard renders it from `meta`.

## Acceptance

- [ ] Either `GET /audit/legacy/:id` exists, or `audit.md` records that the legacy feed is list-only.
- [ ] `dev-tools.md` declares the guaranteed keys on a log entry and states that further keys are the
      writer's context.
- [ ] Whether any log field is truncated server-side is documented, with a flag if it is.
- [ ] `meta.warning` stays on the response.

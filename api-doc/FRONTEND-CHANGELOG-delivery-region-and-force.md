# Admin dashboard — force-push shipments to agents and agencies (2026-10-02)

**Not deployed yet**; ships with jovi-mall. Platform context:
[jovi-mall cross-role page](../../jovi-mall/api-doc/FRONTEND-CHANGELOG-delivery-region-and-force.md).

## Two new routes, one new body field

| Route | Body | What |
|---|---|---|
| `POST /api/v1/shipments/:shipmentId/assign-agent` | `{ agentId, reason, force? }` | Offer a shipment with **no agent** to a named agent of its agency |
| `POST /api/v1/shipments/:shipmentId/move-agency` | `{ agencyId, reason, force? }` | Push a shipment with no agent to a **different agency** |
| `POST /api/v1/shipments/:shipmentId/reassign` | gains `force?` | As before, plus the override |

All three need `shipments.reassign`, which **Support now holds too**: every tier can push and
force-push (owner decision). The tier 3 permission count goes from 39 to 40.

## What `force: true` skips

- **Agent pushes** (`assign-agent`, `reassign` with `agentId`): every eligibility rule and contract
  gate (offline, capacity, tracking, device location, ban, region coverage, value ceiling, COD
  incl. KYC). **Never skipped:** an active contract between the agent and the shipment's agency
  (`platformCode: AGENT_MEMBERSHIP_NOT_APPROVED`). The agent still accepts the offer.
- **Agency push** (`move-agency`): an inactive destination and the COD limits.

UI pattern: send without `force`; on `PLATFORM_OPERATION_REJECTED`, show `details.platformCode`
and offer **"Push anyway"**, which resends with `force: true`.

## Things to get right

- `move-agency` answers `destinationShipmentId`, which **can differ** from the shipment you
  moved (items join the agency's open shipment for that order, and the emptied one is deleted).
  Navigate to it.
- A `pending` shipment (never dispatched by the vendor) stays `pending` after the move; use
  `POST /orders/:orderId/dispatch` to send it.
- Two new audit actions appear on the activity feed and filter: `shipments.agent.assign`,
  `shipments.agency.move`. Their payloads record `force`.

Full reference: [api/shipments.md → Forcing a push](./api/shipments.md#forcing).

# Admin dashboard: orders paid part online, part in cash

> **Date:** 2026-11-01 · **Audience:** the admin dashboard · **Breaking:** nothing on the wire. One new route,
> one new audit action and additive read fields. No new permission.
>
> **Not deployed yet.** It ships with jovi-mall, which owns the money. wi-admin exposes the route, audits it and
> delegates.
>
> The contract pages: [`api/refunds.md`](./api/refunds.md#post-apiv1refundsrefundidpartial-return-fault--ordersrefund) ·
> [`api/orders.md`](./api/orders.md) · [`api/transactions.md`](./api/transactions.md) · [`api/audit.md`](./api/audit.md)

## What it is

A customer can pay part of an order online and the rest in cash to the delivery agent. Each vendor opts in and
sets a minimum. Such an order reads `paymentMethod: "cash_on_delivery"`, so read `partialPayment` to tell the
two apart.

## 1 · The order

`GET /api/v1/orders/:orderId` gains `partialPayment`, on the detail only, `null` on every other order:

```json
"partialPayment": {
  "minPercent": 30,
  "minimumAmount": 6000,
  "maximumAmount": 18000,
  "amountPaidOnline": 6000,
  "balanceDue": 14000,
  "paidAt": "2026-11-01T10:00:00.000Z"
}
```

Show it beside the payment status: *"6,000 paid online, 14,000 due in cash at delivery."* Until `paidAt` is set,
`amountPaidOnline` is 0, `paymentStatus` is `AWAITING_PAYMENT` and the order cannot be dispatched. After that
`paymentStatus` is `partially_paid`, and it becomes `paid` when every parcel's cash has been collected.

## 2 · A returned parcel: the new decision

⚠ **This is the one screen you must build.** No refund of a returned parcel goes out without an administrator, and
some cannot be approved until one says whose fault it was.

A refund request on such a parcel gains `partialReturn`, `null` on every other request:

```json
"partialReturn": {
  "shipmentId": "664a…",
  "fault": "customer",
  "returnFee": 1500,
  "prepaidAmount": 6000,
  "agentReason": "customer_refused",
  "agentNote": "Refused at the door"
}
```

| Field | Meaning |
|---|---|
| `fault` | Who pays, as proposed by the agent's reason: `customer` · `vendor` · `agency`. **`null` means nobody is named yet, and the request cannot be approved** (`422 REFUND_PARTIAL_RETURN_FAULT_REQUIRED`; paying it outside the platform is refused the same way) |
| `agentReason` · `agentNote` | What the administrator weighs. Show both, because the reason can cost the customer money |
| `returnFee` · `prepaidAmount` | The agency's return fee, and what the customer prepaid on this parcel |

`POST /api/v1/refunds/:refundId/partial-return-fault`, under the existing `orders.refund`, with
`{ "fault": "customer" | "vendor" | "agency" }`. It moves no money.

⚠ **It REPLACES the request.** The amount and who pays the fees depend on the fault, so the old request becomes
`rejected` and the response is the new one, **with a new `id`**, still `awaiting_approval`. Move the screen to the
new `id`, then approve that one through the usual approve route.

| Fault | The customer gets | Who pays the fees | The agency's return fee |
|---|---|---|---|
| `customer` | What they prepaid, minus the return fee and the normal refund fees | The customer | Paid from what they prepaid |
| `vendor` | Everything they prepaid | The vendor | Paid, and charged to the vendor |
| `agency` | Everything they prepaid | The agency | Not paid: it earns nothing for the trip |

Suggested order of the screen: the agent's reason and note, then the three choices with what each one means for
the customer, then approve.

`422 REFUND_PARTIAL_RETURN_NOT_APPLICABLE` means the request is not a returned parcel, or is no longer awaiting
approval.

## 3 · Who pays the fees

`fees.paidBy` may now be `agency`, and `fees` gains `agencyCharge`, 0 on every other request. Render it like
`vendorCharge`. A charge a party cannot cover from its balance is recorded as money it owes.

## 4 · The transactions list

A fault charge appears in `GET /api/v1/money/transactions` as kind `earnings_adjustment`, status `refund_clawback`,
`reason.code: "partial_return_fault"`, with `reason.text` explaining it. Its `links` to an order and a refund are
empty, as on other debt movements. See [`api/transactions.md`](./api/transactions.md).

## 5 · The audit log

One new action, `orders.refund.partial_return_fault`. Add its label wherever you list actions by name.

## 6 · Copy again

The permission vocabulary does not move. The route map gains one row, so re-copy it if your dashboard keeps a
mirror of it.

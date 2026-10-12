# Admin dashboard: Wi-Mall Protection, 3 days (2026-10-10)

**Backend built and tested, not deployed yet. The legal documents are already live**
(Terms 2.2 § 19, Returns 1.2 § 10).
Shared rule: `backend/jovi-mall/api-doc/FRONTEND-CHANGELOG-wi-mall-protection.md`.

## What changed

1. **A customer's problem report pauses the earnings of that order or booking**, when it is made
   before the earnings are released (3 days after delivery). New pause reason:
   **`customer_problem_reported`**.
2. **Ending the ticket lifts the pause.** An administrator resolving or closing it is recorded
   as a decision: a later ticket about the same purchase no longer pauses it by itself.
3. **The seller cannot lift it.** A seller, agency or agent changing the ticket's status frees
   nothing.
4. **After the 3 days Wi-Mall has no obligation to refund.** Administrators may still refund, at
   Wi-Mall's own risk, and only for serious cases: fraud, counterfeit or dangerous goods.
5. **Orders and parcels are confirmed automatically after 3 days** (it was 7).

## New in the API

| What | Where |
|---|---|
| `pause.reason: "customer_problem_reported"` | `GET /api/v1/money/earnings/pauses` and `GET /api/v1/money/earnings/pauses/:kind/:id`: a sixth value |
| `holdsEarnings: boolean` | every ticket read on `/api/v1/support/tickets`: list and detail |

No request body changed. No new permission.

## How the pause behaves

| Event | Result |
|---|---|
| Administrator sets the ticket to `resolved` or `closed` | pause lifted; `holdsEarnings` becomes `false`; later tickets on that purchase do not pause it again |
| The customer closes their own ticket | pause lifted; a later ticket can pause it again |
| Seller, agency or agent changes the status | nothing |
| `POST /money/earnings/pauses/:kind/:id/resume` | pause lifted; `holdsEarnings` becomes `false` on **every** ticket about that purchase; later tickets do not pause it again |
| A refund request completes | pause closed with it |
| A refund request is rejected while the ticket is still open | the pause stays, with reason `customer_problem_reported` |
| Two open tickets on one order | the pause stands until the last one ends |

The existing `409 EARNINGS_PAUSE_HELD_BY_REFUND` on resume is unchanged.

There is no automatic expiry. A ticket nobody ends keeps the money paused, so the pause queue
is the place to watch.

## What to build

1. **Pause queue and pause record:** label for the new reason. Link the row to the order's or
   booking's tickets.
2. **Ticket list:** a "Holds earnings" badge on rows with `holdsEarnings: true`.
3. **Ticket detail:** a banner while `holdsEarnings` is `true`.
4. **Resolve and close on such a ticket:** a confirmation before
   `PATCH /support/tickets/:ticketId/status` (`resolved` / `closed`) and before
   `POST /support/tickets/:ticketId/close`.
5. **Resume on a `customer_problem_reported` pause:** a confirmation that it is final.
6. **Refund creation:** a standing notice about refunds after the Protection Period.
7. **Replace every "7 days"** about automatic confirmation with "3 days".

## Copy

| Where | EN | FR |
|---|---|---|
| Pause reason | Customer reported a problem | Problème signalé par le client |
| Ticket badge | Holds earnings | Revenus suspendus |
| Ticket banner | This request keeps the earnings of the order on hold. Resolving or closing it releases them. | Cette demande maintient les revenus de la commande suspendus. La résoudre ou la clôturer les libère. |
| Confirm resolve / close | Release the earnings? Resolving this request lifts the hold on the seller's payment, and a new request on this purchase will not pause it again. If a refund is due, raise it first. | Libérer les revenus ? Résoudre cette demande lève la suspension du paiement du vendeur, et une nouvelle demande sur cet achat ne le suspendra plus. Si un remboursement est dû, créez-le d'abord. |
| Confirm resume | Resume the earnings? This is final for this purchase: open requests stop holding the money. | Reprendre les revenus ? Cette décision est définitive pour cet achat : les demandes ouvertes ne retiennent plus l'argent. |
| Refund notice | After the 3-day Protection Period the seller has been paid. A refund is then paid by Wi-Mall and recovered from the seller as a debt. Refund only for fraud, counterfeit or dangerous goods. | Après la Période de protection de 3 jours, le vendeur a été payé. Un remboursement est alors versé par Wi-Mall et récupéré auprès du vendeur sous forme de dette. Ne remboursez qu'en cas de fraude, de contrefaçon ou de produit dangereux. |

## Docs to read

- [api/money.md](./api/money.md) § Earnings pauses: the reason table (new row)
- [api/support.md](./api/support.md): the ticket shape (`holdsEarnings`), status and close
- [api/refunds.md](./api/refunds.md): unchanged, for the refund notice

## Done when

- The pause queue labels the new reason.
- A ticket with `holdsEarnings: true` shows the badge and the banner, and resolving or closing it
  asks first.
- After resolving it, the pause record reads `active: false` and the ticket `holdsEarnings: false`.

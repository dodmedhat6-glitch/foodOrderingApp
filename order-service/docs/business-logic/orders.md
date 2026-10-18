# Orders

Code: `app/order/`.

## Placing an order (`POST /orders`)

1. Check the basket: 1–100 lines, quantity 1–50, no product listed twice.
2. Read the branch from core (cached). The branch must be active and accepting
   orders, the restaurant must be `active`, and the branch's country must match
   the request's region.
3. Read the address from core. It must belong to the caller.
4. Read prices and stock from core (cached). Unavailable or short lines → 409
   `OutOfStock`, listing the lines.
5. Price it: `subtotal` = sum of lines, `delivery_fee` from the branch,
   `service_fee` = a flat 10 minor units, `total` = all three.
6. **Reserve the stock in core** before writing anything here.
7. Write the order and its items in one transaction. If that fails, give the
   stock back to core.
8. COD → the order starts as `placed` and the kitchen is notified.
   Online → it starts as `pending_payment`, and a Kashier session is opened and
   returned as `payment.redirectUrl`. The kitchen hears about it only once the
   payment is captured.

The request needs an `Idempotency-Key`, so a retry never reserves stock twice.

## Status machine

```
pending_payment ──(payment captured)──> placed ──> accepted ──> preparing ──> ready ──> assigned ──> picked ──> delivered
       │                                  │  └──> rejected        │             │         │  ↑
       └──> cancelled                     └──> cancelled          └─> cancelled └─> cancelled  └── unclaim (back to ready)
```

| Who | Can do |
| --- | --- |
| Restaurant | `placed → accepted / rejected`, `accepted → preparing`, `preparing → ready`, cancel from `accepted`, `preparing`, `ready` |
| Customer | Cancel from `pending_payment` any time; from `placed` within 60s of placing it, and only before the restaurant accepts |
| Agent | `assigned → picked`, `picked → delivered` (only on their own order) |
| System | `pending_payment → placed` (payment captured), `ready → assigned` (claim), cancel an unpaid order (expiry) |
| Admin | Any edge that exists |

- `rejected` and `cancelled` need a `reason`.
- Every change is a compare-and-set on the current status, so two people acting
  at once get one success and one 409.
- Each status stamps its own `<status>_at` column.

## Side effects of a transition

- **WebSocket:** `order.status_changed` (or `order.cancelled`) to the customer,
  the branch and the assigned agent.
- **Cancel or reject before `preparing`:** the reserved stock goes back to core.
  After that the food is already made, so the stock stays used.
- **Cancel or reject a paid online order:** it is refunded automatically.
- **`preparing` or `ready`:** the order becomes available to agents (see
  [deliveries.md](deliveries.md)).
- **`delivered`:** the money settles (see [restaurant-finance.md](restaurant-finance.md)).
- The restaurant's cached order lists for that branch are cleared.

## Reads

- **Customer history** (`GET /customer/orders?year=`): one year at a time,
  newest first. A previous year also reads the archive.
- **Restaurant dashboard**: filter by status and date range. Cached for 10s and
  cleared on every change. A `from` date in a previous year also reads the archive.
- **Order detail**: header, items, payment summary (from the ledger), and the
  agent's name once one is assigned. A customer sees only their own orders, an
  agent only orders assigned to them, a restaurant user only their own
  branches (owners see every branch).

## Partitions

`orders` has one partition per month. A worker job creates the next three
months daily. Lookups by public id go straight to one partition, because the
UUIDv7 carries its creation time.

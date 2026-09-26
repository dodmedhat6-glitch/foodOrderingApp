# Module: Orders (`app/orders`) — Business Logic & Implementation Plan

Owns writes to: `orders`, `order_items`. Read-only dependency on: core-service (restaurant,
branch, product, address, user) via `ICoreServiceClient` (stub for now, `01-system-design.md`
§3.1), cached in Redis and invalidated on write for the critical fields — stock/price/isAvailable
— per `01-system-design.md` §5.1. This is the **first module to build** — everything else
(payments, delivery, restaurant finance) references an `orders` row.

## 1. Order status state machine

```
PENDING_PAYMENT ──(payment fails)──► PAYMENT_FAILED
       │
       │ (payment succeeds, or paymentMethod = COD at creation)
       ▼
     PLACED ──(restaurant rejects)──► REJECTED
       │
       │ (restaurant accepts)
       ▼
    ACCEPTED ──(restaurant/admin cancels)──► CANCELLED
       │
       │ (restaurant starts prep)
       ▼
   PREPARING ──(cancel)──► CANCELLED
       │
       │ (restaurant marks ready)
       ▼
 READY_FOR_PICKUP ──(cancel — rare, requires admin)──► CANCELLED
       │
       │ (delivery assigned — driven by app/delivery-agent, see §3 below)
       ▼
 OUT_FOR_DELIVERY
       │
       │ (delivery completed — driven by app/delivery-agent)
       ▼
   DELIVERED   [terminal]

REJECTED, CANCELLED, PAYMENT_FAILED, DELIVERED are all terminal.
```

**Verb → transition table** for `PATCH /orders/{orderId}/status` (see `03-api-contract.md` §2):

| `action` | Legal from | Result | Notes |
|---|---|---|---|
| `ACCEPT` | `PLACED` | `ACCEPTED`, sets `accepted_at` | |
| `REJECT` | `PLACED` | `REJECTED`, sets `rejected_at`, `rejection_reason` | `reason` required; triggers refund if `paymentStatus = PAID` (see §4) |
| `START_PREPARING` | `ACCEPTED` | `PREPARING` | |
| `MARK_READY` | `PREPARING` | `READY_FOR_PICKUP`, sets `ready_at` | triggers automatic delivery assignment (internal call into `app/delivery-agent`, see `04-modules/delivery-agent.md` §1) |
| `CANCEL` | `PLACED`, `ACCEPTED`, `PREPARING` (admin only beyond `PREPARING`) | `CANCELLED`, sets `cancelled_at`, `cancellation_reason` | `reason` required; triggers refund if paid |

Any other `(action, currentStatus)` pair → `409`. The service layer is the **only** place this
table is encoded (a single `switch`/lookup in `orders.service.ts`) — never duplicated in the
controller or repository.

`OUT_FOR_DELIVERY`/`DELIVERED` are **not** reachable via this endpoint at all — they're only ever
set by `app/delivery-agent` as documented in `02-database-design.md` §2 ("Order status × delivery
status relationship"). `orders.service.ts` exposes an internal
`applyDeliveryStatusSideEffect(orderId, deliveryStatus)` function for exactly that cross-module
write, called by `app/delivery-agent`'s service in the same DB transaction as its own status
update — not over HTTP, since both modules share one process and one regional DB connection.

## 2. Order creation (`POST /orders`) — step by step

1. Validate `CreateOrderDto` (shape only — class-validator).
2. Resolve `branchId → { restaurantId, region, currency }` from core-service (cache-through).
3. Resolve `customerAddressId → { lat, lng, addressText }` from core-service, and verify it
   belongs to the requesting customer (403 otherwise).
4. For each line item, resolve `productId → { name, imageUrl, unitPriceMinor, isAvailable, stock }`
   via `ICoreServiceClient.getProducts(productIds[], branchId)` (a product not sold at this branch
   is a `404`, not a `422` — it's not a valid item for this order at all). **Batch this lookup as
   one call** — never N sequential calls per item, per the "no N+1" rule in `AGENTS.md`. This read
   goes through the `cache:core:product:{id}` read-through cache; because stock/`isAvailable` are
   invalidation-covered (`01-system-design.md` §5.1), a cache hit here is trustworthy up to the
   invalidation event's delivery, not just the TTL.
5. Reject if any item `isAvailable = false` **or** `quantity > stock` → `422`.
6. Compute `subtotalMinor = Σ(unitPriceMinor × quantity)`, `deliveryFeeMinor`/`serviceFeeMinor`
   (fee calculation rules are a core-service/business config lookup — **exact formula TBD**,
   tracked as an open question; until defined, treat as a configured flat fee per region, cached).
7. Open a DB transaction (in the resolved region's connection):
   a. Generate `orders.id` (Snowflake, region-aware — `pkg/id`).
   b. Insert `orders` row: `status = PENDING_PAYMENT` (ONLINE) or `PLACED` (COD),
      `paymentStatus = PENDING` (ONLINE) or `COD_PENDING` (COD).
   c. Insert all `order_items` rows (single multi-row `INSERT`, not one insert per item).
   d. Commit.
8. If `paymentMethod = ONLINE`: synchronously call `app/payments`'s internal
   `initPaymentForOrder(order)` (in-process, not HTTP — see `AGENTS.md` on internal module calls)
   to obtain `paymentSessionUrl`, include it in the response. If `paymentMethod = COD`: no
   payment call at all; the order is immediately visible to the restaurant.
9. Publish an `order.created` event to the async Analytics channel (fire-and-forget — never
   blocks the response; failures here are logged, not surfaced to the client).

**Idempotency**: the whole sequence above runs inside the idempotency middleware (§0 of the API
contract) — a retried request with the same `Idempotency-Key` and body short-circuits to the
cached response before step 2 ever runs.

## 3. Interaction with delivery assignment

`app/orders` never assigns a delivery agent itself. When step "MARK_READY" transition commits,
`orders.service.ts` calls `deliveryAgentService.assignForOrder(orderId)` (in-process call across
modules — both live in the same deployable, this is a plain function call through DI, not a
network hop) **after** its own transaction commits (assignment has its own transaction/retry
semantics — see `04-modules/delivery-agent.md` §1 — and must not be nested inside the order's
transaction, since a failed assignment attempt should never roll back the "ready" status).

## 4. Interaction with payments/refunds

- `REJECT` or `CANCEL` on an order whose `paymentStatus` is `PAID` triggers
  `paymentsService.refundForOrder(orderId, reason)` (in-process call into `app/payments`) —
  **after** the order's own status transition commits, same reasoning as §3.
- `app/orders` never writes to `transactions` directly — it only ever calls into
  `app/payments`'s service layer, which owns that table (one-writer-per-table rule,
  `05-folder-structure.md` §8).

## 5. Read-path performance rules (customer/restaurant list endpoints)

- `GET /customer/orders` and `GET /restaurant/orders` **never** join `order_items` — list views
  use `OrderListItemResponseDto` (no items array). A client drilling into one order calls
  `GET /orders/{orderId}`, which does join items, but that's a single-row fetch, not N.
- Both list endpoints require a bounded page size (`limit`, capped — see `AGENTS.md` performance
  rules) and cursor pagination; no unbounded `SELECT *` list endpoint exists anywhere in this
  module.
- `GET /restaurant/orders` is the module's hottest read (dashboards poll it) — implemented first
  with the query builder against `idx_orders_branch_status_created` /
  `idx_orders_restaurant_status_created`; only escalate to raw SQL if profiling under realistic
  load shows the query builder's plan is insufficient (per `01-system-design.md` §3/§6).

## 6. Implementation plan (this module, in order)

Matches the checklist convention in `05-folder-structure.md` (formalizing core-service's own
informal `workflow` file):

1. **Migrations**: `orders`, `order_items` tables + all indexes from `02-database-design.md` §3.1,
   §3.2, plus the yearly partitioning setup for `orders` (§5 of that doc). The `order_status`,
   `order_payment_method`, `order_payment_status` enum types (§2 of that doc).
2. **`pkg/id`**: Snowflake ID generator (shared with `app/payments` for `transactions.id` — build
   it once, here, since orders needs it first).
3. **Entities**: `entity/order.entity.ts`, `entity/order-item.entity.ts`.
4. **Repository**: `repository/orders.repository.ts` — `insertOrder`, `insertOrderItems`,
   `findOrderById` (joins items), `findOrdersByCustomer` (list, no items),
   `findOrdersByRestaurant` (list, no items, filterable), `updateOrderStatus`,
   `applyPaymentStatus` (called by `app/payments`, not exposed as a public HTTP action).
5. **Service**: `service/orders.service.ts` — creation orchestration (§2), the status state
   machine (§1), the cross-module hooks (§3, §4).
6. **DTOs**: `dto/request/create-order.dto.ts`, `dto/request/update-order-status.dto.ts`,
   `dto/response/order.response-dto.ts`, `dto/response/order-list-item.response-dto.ts`.
7. **Controller**: `controller/orders.controller.ts`.
8. **Routes**: `routes.ts` — mount `POST /orders`, `GET /orders/:orderId`,
   `GET /customer/orders`, `GET /restaurant/orders`, `PATCH /orders/:orderId/status`; **mount the
   router in `src/routes.ts` in the same commit** (core-service shipped a router that was never
   mounted — see `05-folder-structure.md` §6 — do not repeat that).
9. Unit tests for the state machine table (§1) — every legal and illegal `(action, status)` pair.
10. Integration test for `POST /orders` happy path (COD) end-to-end against a test DB — this is
    the first real test in the repo (core-service shipped with none; we don't inherit that gap).
11. **Archival worker** (`worker/archive-orders.worker.ts`) — see §7 below. Not required for the
    first `POST /orders` happy path to work, but owned by this module and built alongside it, not
    deferred to a later module.

## 7. Background worker: yearly archival

Per `01-system-design.md` §7.4/§11, this module owns the yearly archival job (the service's
reference background worker):

- For each configured country/region: connect to that region's **hot** shard and its **cold**
  archive database (two pools held open for the run).
- Detach the just-completed year's `orders`/`order_items` partitions (per `02-database-design.md`
  §5), copy their rows into the matching tables in the cold database, verify row counts match,
  then drop the detached hot-shard partition.
- Reuses `repository/orders.repository.ts` read functions for the copy (no separate batch-only
  query layer) and the same `resolveRegionConnection(region)` path request-time code uses, applied
  once per configured region rather than per-request.
- Safe to re-run: a crash between copy and verify-and-drop leaves the hot partition intact (copy
  not yet verified, so nothing was dropped) and a re-run just repeats the copy.

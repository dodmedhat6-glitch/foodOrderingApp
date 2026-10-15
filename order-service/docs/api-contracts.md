# API contracts

Base path `/api`. JSON in and out.

## Conventions

| Header | When |
| --- | --- |
| `Authorization: Bearer <token>` or the `access_token` cookie | Every endpoint except the payment webhook. Same JWT as core-service. |
| `X-Region: eg` | Every endpoint except the webhook. Missing → 400. |
| `Idempotency-Key` | Required on endpoints marked **idem**. Same key + same body → the stored response. Same key + different body → 409. |

- Success: `{ "success": true, "data": ... }`. Lists add `meta: { nextCursor, hasMore, count }`.
- Error: `{ "success": false, "data": { "message": "<ErrorName>", ...details } }`.
- Money: integer minor units, with a `currency` field beside it.
- Times: ISO-8601 UTC.
- Order ids on the wire are UUIDs (`publicId`).
- Pagination: `?limit=` (max 100) and `?cursor=` taken from `meta.nextCursor`.

Restaurant endpoints sit under `/restaurants/:restaurantId/...` and check that
the caller belongs to that restaurant (and branch), then check a permission.
System admins pass every check.

## Orders

| Method & path | Who | Notes |
| --- | --- | --- |
| `POST /orders` | customer | **idem**. Places an order. |
| `GET /customer/orders?year=` | customer | Own orders, newest first. `year` defaults to the current year. |
| `GET /orders/:orderId` | customer, agent, admin | Full detail. Customers see only their own orders, agents only orders assigned to them. |
| `PATCH /orders/:orderId/status` | customer, agent, admin | **idem**. Customer: cancel. Agent: `picked`, `delivered`. |
| `GET /restaurants/:rid/branches/:bid/orders?status=&from=&to=` | `orders:read` | Branch dashboard, cached 10s. |
| `GET /restaurants/:rid/branches/:bid/orders/:orderId` | `orders:read` | Detail, limited to that branch. |
| `PATCH /restaurants/:rid/branches/:bid/orders/:orderId/status` | `orders:accept` (accept/reject), `orders:update` (preparing/ready), `orders:cancel` | **idem** |

Place order request:

```json
{ "branchId": 1, "customerAddressId": 1, "paymentMethod": "cod" | "online",
  "items": [ { "productId": 1, "quantity": 2 } ] }
```

The response is the order detail. An online order also carries
`payment: { sessionId, redirectUrl }` for the hosted checkout.

Status request: `{ "status": "<target>", "reason": "..." }`. `reason` is
required for `rejected` and `cancelled`.

## Payments

| Method & path | Who | Notes |
| --- | --- | --- |
| `POST /payments/init` | customer | **idem**. `{ orderId }`. Opens or reuses a checkout session for an unpaid online order. |
| `POST /payments/webhook/:provider` | provider (signed) | No auth headers; the signature is verified. Always 200 unless processing really failed. |
| `GET /payments/:paymentId` | admin | One ledger row. |
| `GET /restaurants/:rid/branches/:bid/payments/:paymentId` | `payments:read` | Same, limited to that branch. |
| `POST /payments/:paymentId/refund` | admin | **idem**. `{ amount?, reason }`. 202: online refunds settle later via the webhook. |

## Delivery & agents

| Method & path | Who | Notes |
| --- | --- | --- |
| `POST /agents/presence/online` | agent | `{ lat, lng }` |
| `POST /agents/presence/ping` | agent | `{ lat, lng }`, every ~30s. 409 `NotOnline` if the agent's presence has expired. |
| `POST /agents/presence/offline` | agent | Hands back an `assigned` order; refused while `picked`. |
| `GET /agents/tasks?status=` | agent | The agent's own orders. |
| `GET /agents/earnings?from=&to=` | agent | List plus totals for the range (defaults to this month). |
| `POST /orders/:orderId/claim` | agent | Take an offered order. First claim wins; the rest get 409. |
| `POST /orders/:orderId/unclaim` | agent | Give it back before pickup. |
| `POST /orders/:orderId/assign` | admin | **idem**. `{ agentId }`. Manual assignment. |

## Restaurant finance

| Method & path | Who | Notes |
| --- | --- | --- |
| `GET /restaurants/:rid/finance/balance` | `finance:read` | `{ restaurantId, balances: [{ currency, balance, updatedAt }], asOf }` |
| `GET /restaurants/:rid/finance/payouts?from=&to=` | `finance:read` | Payouts, newest first. Defaults to the last 90 days. |
| `GET /restaurants/:rid/finance/summary?from=&to=` | `finance:read` | Per currency: `grossSales, commission, refunds, net, payouts`. Defaults to this month. |
| `POST /restaurants/:rid/finance/payouts` | admin | **idem**. `{ amount, currency, providerReferenceId }`. Records a bank transfer already made. 201. |

## Health

`GET /health` pings every shard.

## Errors

| Error | HTTP | Meaning |
| --- | --- | --- |
| validation message | 400 | Bad body, path or query |
| `DuplicateProductInOrder` | 400 | The same product appears twice in `items` |
| `ReasonRequired` | 400 | Reject/cancel without a reason |
| `InvalidSignature` | 401 | Webhook signature check failed |
| `AddressNotOwned` | 403 | Address belongs to someone else |
| `NotYourDelivery` | 403 | Agent acting on another agent's order |
| `OrderNotFound`, `PaymentNotFound`, `AgentNotFound` | 404 | Not found, or not yours to see |
| `UnknownPaymentProvider` | 404 | Webhook for an unknown provider |
| `IdempotencyConflict` | 409 | Same key, different request |
| `InvalidStatusTransition` | 409 | Not allowed from the current status (details: `from`, `to`) |
| `CancellationWindowExpired` | 409 | Customer cancel after the window (see orders.md) |
| `BranchNotAcceptingOrders` | 409 | Branch closed, inactive, or restaurant not active |
| `OutOfStock` | 409 | details: the lines that are short |
| `OrderNotPendingPayment`, `OrderNotOnlinePayment` | 409 | Payment init on the wrong kind of order |
| `NotARefundableCharge`, `RefundExceedsCharge` | 409 | Refund rules |
| `OrderNotReady`, `OrderAlreadyAssigned`, `NotOnline`, `AgentInActiveDelivery`, `CannotUnclaimAfterPickup`, `DispatchManagedTransition` | 409 | Dispatch rules |
| `InsufficientBalance` | 409 | Payout larger than the balance |
| `PaymentProviderRejected` | 502 | Kashier said no |
| `Payment provider unavailable`, `Core service unavailable` | 503 | Upstream down; safe to retry |

## WebSocket

Connect to `/ws` (socket.io) with `auth: { token }`. The server replies with
`hello { allowedChannels }`. Then `emit("subscribe", channel, ack)`.

| Event | Room | When |
| --- | --- | --- |
| `order.created` | `branch:<id>`, `restaurant:<id>` | A new order reaches the kitchen (COD at placement, online at payment capture) |
| `order.status_changed` | `customer:<id>`, `branch:<id>`, the agent if assigned | Any status change except cancellation |
| `order.cancelled` | same rooms | Order cancelled (instead of `status_changed`) |
| `payment.captured` / `payment.failed` / `payment.refunded` | `customer:<id>` | Payment outcomes |
| `task.offered` | `agent:<id>` | Order offered to nearby agents |
| `task.assigned` / `task.taken` | `agent:<id>` | You won the claim / someone else did |
| `task.cancelled` | `agent:<id>` | Your order was cancelled |
| `delivery.position` | `customer:<id>` | Agent location while delivering your order |
| `assignment.stalled` | `admin` | No agent took the order after the maximum offers |
| `finance.payout_recorded` | `restaurant:<id>` | Payout recorded; carries the new balance |

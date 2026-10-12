# API Contracts — `order-service`

All endpoints are mounted under `/api`. Authentication via JWT in cookie `access_token` (same as core-service). Cross-cutting headers, conventions, error envelope, response envelope, and per-endpoint request/response DTOs follow.

---

## 0. Conventions

### Headers (in)

| Header                | Required where                            | Notes                                      |
| --------------------- | ----------------------------------------- | ------------------------------------------ |
| `Cookie: access_token` | All authenticated endpoints              | Issued by core-service `/api/auth/login`   |
| `Idempotency-Key`     | All `POST` / `PATCH` write endpoints      | Strict on order create, payment init, payouts |
| `X-Region`            | Required for every request (admin may pass `all` for fan-out reads) | `eg`, `sa`, ... (one per country) |
| `X-CorrelationId`     | Propagated; auto-generated otherwise      | Returned on all responses                  |

### Headers (out)

| Header               | Always present                                        |
| -------------------- | ----------------------------------------------------- |
| `X-CorrelationId`    | Request id (echoed if provided, generated otherwise)  |
| `X-Cache: HIT|MISS`  | Endpoints behind `withCache`                          |

### Response envelope

```jsonc
// success (single)
{ "success": true, "data": <DTO>, "meta": { ... }? }

// success (paginated)
{ "success": true, "data": [<DTO>, ...], "meta": { "nextCursor": "...", "hasMore": true, "count": 20 } }

// error
{ "error": "<message>" }
```

HTTP status codes:
- 200 OK — success
- 201 Created — POST that created a resource
- 400 — validation error
- 401 — not authenticated
- 403 — not authorized
- 404 — not found
- 409 — conflict (idempotency mismatch, illegal status transition, insufficient balance, stock)
- 422 — semantic invalid (rare; we mostly use 400)
- 503 — upstream unavailable (core-service / Kashier)

### Money

Always integer minor units, with a sibling `currency` field (e.g. `"EGP"`, `"SAR"`).

### Timestamps

ISO 8601 UTC strings, e.g. `"2026-04-16T15:42:11.123Z"`.

### IDs

- Public order id: UUID string (`publicId`).
- Other public ids: bigint serialized as JSON number.
- Internal ids never leave this service.

### Pagination (cursor)

Query: `?cursor=<opaque>&limit=20&sortBy=createdAt&sortOrder=desc`
Response meta: `{ nextCursor, hasMore, count }`.

### Filters

`?filter[<field>][<op>]=<value>` — same shape as core-service. Allowed ops: `eq, gt, lt, gte, lte, like, in`.

---

## 1. Orders

### 1.1 POST /api/orders — place order

Headers: `Cookie: access_token`, `Idempotency-Key` (strict).

**Request body**

```ts
class CreateOrderRequestDTO {
  @IsInt() @Min(1)
  branchId!: number;

  @IsInt() @Min(1)
  customerAddressId!: number;

  @IsEnum(PaymentMethod)
  paymentMethod!: 'online' | 'cod';

  @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OrderItemInputDTO)
  items!: OrderItemInputDTO[];
}

class OrderItemInputDTO {
  @IsInt() @Min(1)
  productId!: number;

  @IsInt() @Min(1) @Max(50)
  quantity!: number;
}
```

**Response 201**

```ts
class OrderResponseDTO {
  publicId: string;            // UUID
  status: OrderStatus;         // 'pending_payment' | 'placed' | ...
  paymentMethod: 'online' | 'cod';
  branch: { id: number; name: string };           // joined snapshot
  restaurant: { id: number; name: string };       // joined snapshot
  customerAddress: { lat: number; lng: number; addressText: string };
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  total: number;
  currency: string;
  items: OrderItemResponseDTO[];
  createdAt: string;
  // online only:
  payment?: { sessionId: string; redirectUrl: string };  // present if paymentMethod=='online' and init succeeded
}

class OrderItemResponseDTO {
  productId: number;
  name: string;
  imageUrl?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}
```

**Errors**

| Status | Body                                                                 |
| ------ | -------------------------------------------------------------------- |
| 400    | `{ "error": "items: array must contain at least 1 element" }`        |
| 401    | `{ "error": "User not authenticated" }`                              |
| 403    | `{ "error": "User not authorised" }`                                 |
| 409    | `{ "error": "BranchNotAcceptingOrders" }`                            |
| 409    | `{ "error": "OutOfStock", "details": [{ "productId": 1, "requested": 3, "available": 1 }] }` |
| 409    | `{ "error": "IdempotencyConflict" }`                                 |
| 503    | `{ "error": "Core service unavailable" }`                            |

---

### 1.2 GET /api/orders/{publicId}

**Path params**: `publicId` (UUID).

**Auth**: customer (own), delivery_agent (the order they carry), system_admin.

Restaurant staff read the same order through the branch-scoped path in §1.2b.
Two paths rather than one because the two are authorized by different
questions: here the caller *is* the subject (the JWT decides), there the order
is a tenant resource and the answer is a permission in core's catalog, which
needs the restaurant and branch in the path so `requireRestaurantMember` and
`requireBranchAccess` can run as middleware.

---

### 1.2b GET /api/restaurants/{restaurantId}/branches/{branchId}/orders/{publicId}

**Path params**: `restaurantId`, `branchId` (positive integers), `publicId` (UUID).

**Auth**: restaurant_user with `orders:read`, a member of `restaurantId` and of
`branchId` (an owner passes on the restaurant alone); system_admin.

Response is identical to §1.2. The scope is not only checked — it is pushed
into the query, so the lookup filters on `(restaurant_id, branch_id, public_id)`
and an order id belonging to a neighbouring branch returns **404**, not 403.

**Response 200**

```ts
class OrderDetailResponseDTO extends OrderResponseDTO {
  delivery?: DeliverySummaryResponseDTO;
  paymentSummary: {
    method: 'online' | 'cod';
    status: 'pending' | 'authorized' | 'captured' | 'failed' | 'refunded';
    amount: number;
    currency: string;
    refundedAmount: number;
  };
  history: Array<{ status: OrderStatus; ts: string }>;
}

// Projected from the order row itself — there is no `deliveries` table and no
// delivery id on the wire. The order's publicId is the only handle.
class DeliverySummaryResponseDTO {
  // No phone: core's internal user lookup returns { id, name, email } and nothing more.
  agent?: { id: number; name: string };
  assignedAt?: string;
  pickedAt?: string;
  deliveredAt?: string;
}
```

---

### 1.3 GET /api/customer/orders?year=YYYY

**Query**: `year`, `cursor`, `limit`, `sortBy=createdAt`, `sortOrder=desc`.

**Auth**: customer.

**Response 200** (paginated)

```ts
class OrderSummaryResponseDTO {
  publicId: string;
  status: OrderStatus;
  total: number;
  currency: string;
  itemsCount: number;
  restaurant: { id: number; name: string };
  branchId: number;
  createdAt: string;
}
```

---

### 1.4 GET /api/restaurants/{restaurantId}/branches/{branchId}/orders

**Path params**: `restaurantId`, `branchId` (positive integers).

**Query**: `status?`, `from?` (ISO), `to?` (ISO), pagination, filters. The
branch is no longer a query param — it is the path.

**Auth**: restaurant_user with `orders:read`, a member of `restaurantId` and of
`branchId`; system_admin.

**Response 200**: paginated `OrderSummaryResponseDTO[]`, filtered on
`(restaurant_id, branch_id)` in the query itself. A branch id that does not
belong to `restaurantId` yields an empty page.

Cached for `RESTAURANT_ORDERS_CACHE_TTL_SEC` (10s default) under
`<region>:restaurant:orders:<branchId>:<filters>`; every status transition on
the branch clears the whole family explicitly.

---

### 1.5 PATCH /api/orders/{orderId}/status

**Path**: `orderId` (publicId).

**Headers**: `Idempotency-Key` (strict).

**Auth**: customer (cancel within the window on their own order),
delivery_agent (picked/delivered on the order they carry), system_admin.
Restaurant staff use §1.5b — this route rejects `restaurant_user` outright so
the flat path cannot become a way around the permission check there.

**Request body**

```ts
class UpdateOrderStatusRequestDTO {
  @IsEnum(OrderStatus)
  status!: 'accepted' | 'rejected' | 'preparing' | 'ready' | 'cancelled';

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;  // required for rejected/cancelled
}
```

**Response 200**

```ts
class OrderStatusResponseDTO {
  publicId: string;
  status: OrderStatus;
  updatedAt: string;
}
```

**Errors**

| Status | Body                                                  |
| ------ | ----------------------------------------------------- |
| 409    | `{ "error": "InvalidStatusTransition", "from": "...", "to": "..." }` |
| 409    | `{ "error": "CancellationWindowExpired" }`            |

---

### 1.5b PATCH /api/restaurants/{restaurantId}/branches/{branchId}/orders/{orderId}/status

**Path params**: `restaurantId`, `branchId`, `orderId` (publicId).

**Headers**: `Idempotency-Key` (strict).

**Auth**: restaurant_user, member of both ids, holding the permission the
**requested target** implies — `orders:accept` for `accepted`/`rejected`,
`orders:update` for `preparing`/`ready`, `orders:cancel` for `cancelled`
(docs/business-logic/rbac.md §3). A target outside that set is denied before
the body is validated. system_admin bypasses.

One endpoint rather than three, per CLAUDE.md §4: the permission is resolved
from `body.status` by the `rbac()` middleware, and which transitions are
*legal* remains the status machine's answer, not the route's.

Request body and response are identical to §1.5. As in §1.2b the scope is in
the query, so an order outside `branchId` is a 404.

---

## 2. Payments

### 2.1 POST /api/payments/init

**Headers**: `Cookie`, `Idempotency-Key` (strict).

**Request**

```ts
class InitPaymentRequestDTO {
  @IsUUID()
  orderId!: string;
}
```

**Response 200**

```ts
class PaymentInitResponseDTO {
  sessionId: number;            // our payment_sessions.id
  providerSessionId: string;    // Kashier's session _id
  redirectUrl: string;          // send the customer here
  expiresAt: string;            // ISO 8601 UTC
  amount: number;               // minor units
  currency: string;
  status: 'initialized' | 'pending' | 'authorized';
}
```

Idempotent at the domain level as well as through `Idempotency-Key`: an order
that already has a payable session gets **that session** back rather than a
second one.

`POST /api/orders` with `paymentMethod: "online"` already returns
`payment: { sessionId, redirectUrl }` (`sessionId` there is the *provider's*
session id), so this endpoint is the recovery path rather than the normal one.

**Errors**

| Status | Body                                          |
| ------ | --------------------------------------------- |
| 400    | `{ "error": "Missing Idempotency-Key header" }` |
| 403    | `{ "error": "Permission denied" }` — caller is not a customer |
| 404    | `{ "error": "OrderNotFound" }` — unknown, or not the caller's order |
| 409    | `{ "error": "OrderNotPendingPayment" }`       |
| 409    | `{ "error": "OrderNotOnlinePayment" }` — the order is COD |
| 409    | `{ "error": "IdempotencyConflict" }` — same key, different body |
| 502    | `{ "error": "PaymentProviderRejected", "provider": "kashier", "providerStatus": 400, "providerMessage": "..." }` |
| 503    | `{ "error": "Payment provider unavailable" }` |

---

### 2.2 POST /api/payments/webhook/{provider}

**Path**: `provider` ∈ `{ "kashier" }`.

**Auth**: none. The HMAC in `x-kashier-signature` is the authentication, verified
against the **Payment API Key** (Kashier has no separate webhook secret). The
region is not a header either — it travels inside the signed `merchantOrderId`.

**Body**: the provider's raw payload, kept as-is in
`payment_webhook_events.payload`.

**Response**: **200 with an empty body** for everything the provider cannot fix
by resending — success, a duplicate, an unrecognised reference, an amount that
does not match the session. The body is empty on purpose: Kashier discards it,
and reporting internal state to an unauthenticated caller would tell a prober
which references exist.

**Errors**

| Status | Body                                  |
| ------ | ------------------------------------- |
| 401    | `{ "error": "InvalidSignature" }`     |
| 404    | `{ "error": "UnknownPaymentProvider" }` — `{provider}` is not `kashier` |
| 500    | a genuine processing failure — Kashier retries, which is the intent |

---

### 2.3 GET /api/payments/{paymentId}

**Auth**: system_admin only. Restaurant staff use §2.3b; an admin has no
restaurant or branch to name and would otherwise have to guess a pair.

---

### 2.3b GET /api/restaurants/{restaurantId}/branches/{branchId}/payments/{paymentId}

**Auth**: restaurant_user with `payments:read` (seeded onto `owner` alone),
member of both ids. The branch travels into the order lookup behind the
payment, so a payment on another branch's order is a 404.

Response is identical to §2.3.


**Auth**: `payments:read` (restaurant owner) or system_admin.

**Response 200**

```ts
class PaymentResponseDTO {
  id: number;
  orderId: string | null;       // the order's public UUID; null for a payout
  type: 'charge' | 'refund' | 'commission' | 'cod_collection' | 'payout' | 'adjustment';
  method: 'online' | 'cod' | 'bank_transfer' | 'system';
  provider: 'kashier' | 'cod' | null;
  providerReferenceId: string | null;
  status: 'pending' | 'succeeded' | 'failed' | 'reversed';
  amount: number;               // minor units
  currency: string;
  isRefunded: boolean;          // true only once refunds reach the full amount
  refundedPaymentId: number | null;  // on a refund row: the charge it repays
  createdAt: string;
  updatedAt: string;
}
```

`provider` is the name, never the internal numeric id. `providerReferenceId` is
included deliberately — it is what a support agent quotes to Kashier, and the
customer already sees it on their statement.

**Errors**

| Status | Body                              |
| ------ | --------------------------------- |
| 400    | `{ "error": "Invalid payment id" }` |
| 403    | `{ "error": "Permission denied" }` — no `payments:read` (e.g. a customer) |
| 404    | `{ "error": "PaymentNotFound" }` — unknown, or another restaurant's |

---

### 2.4 POST /api/payments/{paymentId}/refund

**Auth**: system_admin.

**Headers**: `Idempotency-Key` (strict).

**Request**

```ts
class RefundRequestDTO {
  @IsOptional() @IsInt() @Min(1)
  amount?: number;  // omit → full refund

  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}
```

**Response 202** (accepted; final state via webhook):

```ts
class RefundAcceptedResponseDTO {
  refundId: number;
  status: 'pending' | 'succeeded';   // 'succeeded' only for COD, which moves no money
  amount: number;                    // minor units
  currency: string;
}
```

202 and not 200: Kashier accepting a refund is not the money having moved. The
row stays `pending` until its webhook arrives. Omitting `amount` refunds the
full **remaining** amount, which is less than the charge once a partial refund
has gone through.

**Errors**

| Status | Body                                      |
| ------ | ----------------------------------------- |
| 400    | `{ "error": "Missing Idempotency-Key header" }` |
| 403    | `{ "error": "Permission denied" }` — not a system admin |
| 404    | `{ "error": "PaymentNotFound" }`          |
| 409    | `{ "error": "NotARefundableCharge" }` — not a succeeded charge, or no captured session to address the refund to |
| 409    | `{ "error": "RefundExceedsCharge" }`      |
| 502    | `{ "error": "RefundRejected" }` / `{ "error": "PaymentProviderRejected", ... }` |
| 503    | `{ "error": "Payment provider unavailable" }` — the refund row is left `pending` |

---

## 3. Deliveries

### 3.1 POST /api/orders/{publicId}/claim

An agent claims an order they were offered. **This is the assignment** — there is
no separate accept step and no `deliveries` resource; the delivery is a phase of
the order (`docs/database-design.md` §3.7).

**Auth**: `delivery_agent`.

**Request**: no body. The agent is the JWT subject; the order is the path.

**Response 200**

```ts
class DeliveryTaskResponseDTO {
  orderPublicId: string;
  status: 'assigned' | 'picked' | 'delivered';
  pickup:  { branchId: number; name: string; addressText: string; lat: number; lng: number };
  dropoff: { addressText: string; lat: number; lng: number };
  customer: { name: string };
  itemsCount: number;
  total: number;        // minor units
  currency: string;
  paymentMethod: 'online' | 'cod';   // cod => the agent collects `total` on handoff
  earningEstimate: number;           // minor units
  assignedAt: string;                // ISO 8601 UTC
  expiresAt?: string;                // present only on a `task.offered` payload
}
```

**Errors**

| Status | Body                                                                           |
| ------ | ------------------------------------------------------------------------------ |
| 409    | `{ "error": "OrderAlreadyAssigned" }` — another agent won the race              |
| 409    | `{ "error": "OrderNotReady" }` — the order is not in `ready`                    |
| 409    | `{ "error": "AgentInActiveDelivery" }` — the agent already holds an order       |
| 409    | `{ "error": "NotOnline" }` — the agent has no live presence row                 |

The race is resolved by a conditional UPDATE, so exactly one concurrent claimer
gets 200 and the rest get `OrderAlreadyAssigned`.

---

### 3.2 POST /api/orders/{publicId}/unclaim

Hands an `assigned` order back; it returns to `ready` and is re-offered.

**Auth**: the assigned `delivery_agent`.

**Response 200**: `{ ok: true }`

**Errors**

| Status | Body                                                                        |
| ------ | --------------------------------------------------------------------------- |
| 403    | `{ "error": "NotYourDelivery" }`                                             |
| 409    | `{ "error": "CannotUnclaimAfterPickup" }` — order is `picked`                 |

---

### 3.3 POST /api/orders/{publicId}/assign

Admin override: force-assign an order to a named agent, bypassing the offer.

**Auth**: `system_admin` (by role, not an RBAC permission — nothing new to seed in core).

**Request**

```ts
class AssignDeliveryRequestDTO {
  agentId!: number;
}
```

**Response 200**: `DeliveryTaskResponseDTO`.

**Errors**: as §3.1, plus `404 { "error": "AgentNotFound" }` (checked through
`GET /api/internal/agents/:id` on core) and
`409 { "error": "MaxAssignmentAttemptsReached" }`.

Idempotency: `idempotency({strict: true})` — it is an assignment, and a retried
POST must not bounce the order between two agents.

---

### 3.4 Agent status transitions — use the order endpoint

`picked` and `delivered` are **order** transitions, not delivery ones. They go
through `PATCH /api/orders/{publicId}/status` (§1.3) with the agent's JWT:

| From       | To          | Notes                                        |
| ---------- | ----------- | -------------------------------------------- |
| `assigned` | `picked`    | stamps `picked_at`                            |
| `picked`   | `delivered` | stamps `delivered_at`, runs settlement        |

**Errors specific to the agent actor**

| Status | Body                                      |
| ------ | ----------------------------------------- |
| 403    | `{ "error": "NotYourDelivery" }`           |
| 409    | `{ "error": "InvalidStatusTransition" }`   |

There is no `PATCH /api/deliveries/{deliveryId}/status`.

---

## 4. Agents

### 4.1 POST /api/agents/presence/online

**Auth**: delivery_agent.

**Request**

```ts
// One DTO for `online` and `ping`. Bounds are validated, not assumed: a
// transposed pair poisons the geo set and produces offers from the wrong continent.
class PresenceRequestDTO {
  @IsNumber() @Min(-90)  @Max(90)  lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
}
```

**Response 200**: `{ "ok": true }`.

### 4.2 POST /api/agents/presence/offline

Empty body. Response 200 `{ "ok": true }` or 409 `AgentInActiveDelivery`.

### 4.3 POST /api/agents/presence/ping

Same body as `online`. Response 200 `{ "ok": true }` or 409 `NotOnline`.

### 4.4 GET /api/agents/tasks?status=

**Query**: `status?`, pagination.

**Response 200**: paginated `DeliveryTaskResponseDTO[]` (defined in §3.1).

Read from `orders` where `delivery_agent_id = <jwt subject>`, cursor on
`assigned_at DESC`, backed by the partial `idx_orders_delivery_agent_id_status`.
`status` filters to `assigned | picked | delivered`. There is no `deliveryId` —
the handle is `orderPublicId`.

### 4.5 GET /api/agents/earnings?from=&to=

**Response 200**: `AgentEarningsResponseDTO` (see `docs/business-logic/agents.md` §4).

`orderPublicId` on each row is read from the denormalized
`agent_earnings.order_public_id`, so this endpoint never reads `orders`.

---

## 5. Restaurant Finance

### 5.1 GET /api/restaurant/balance

**Auth**: `finance:read`.

**Response 200**

```ts
class RestaurantBalanceResponseDTO {
  restaurantId: number;
  balances: Array<{ currency: string; balance: number }>;
  asOf: string;
}
```

### 5.2 GET /api/restaurant/payouts?from=&to=

**Auth**: `finance:read`.

**Response 200**: paginated `PayoutResponseDTO[]`.

```ts
class PayoutResponseDTO {
  id: number;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'reversed';
  providerReferenceId?: string;
  createdAt: string;
}
```

### 5.3 POST /api/restaurant/payouts (admin)

**Auth**: system_admin. **Headers**: `Idempotency-Key` (strict).

**Request**

```ts
class CreatePayoutRequestDTO {
  @IsInt() @Min(1)         restaurantId!: number;
  @IsInt() @Min(1)         amount!: number;
  @IsEnum(Currency)        currency!: 'EGP' | 'SAR';
  @IsString() @MinLength(1) providerReferenceId!: string;
  @IsOptional() @IsString() note?: string;
}
```

**Response 201**: `PayoutResponseDTO`.

**Errors**: 409 `InsufficientBalance`, 409 `IdempotencyConflict`.

---

## 6. WebSocket protocol (socket.io)

### 6.1 Connect

```ts
const socket = io("wss://<host>", {
    path: "/ws",
    auth: { token: "<jwt>" },   // or ?token=, or Cookie: access_token
    transports: ["websocket"],
});
```

Connection middleware validates the JWT. Rejected handshakes receive a `connect_error` with the reason; invalid token = `"Unauthorized"`.

### 6.2 Client → Server events

```ts
socket.emit("subscribe",   "branch:42", (ack) => { /* { ok: true } | { ok: false, error } */ });
socket.emit("unsubscribe", "branch:42");
```

Allowed rooms are derived from the JWT at connect time. Forbidden rooms return `{ ok: false, error: "not permitted" }` — connection stays open.

### 6.3 Server → Client events

```ts
// emitted once at connect
socket.on("hello", ({ allowedChannels }) => { /* list of rooms the user may join */ });

// emitted when a subscribe succeeds
socket.on("subscribed", ({ channel }) => { /* ... */ });

// domain events
socket.on("order.status_changed", (payload) => {
    // { orderPublicId, status, updatedAt }
});
socket.on("delivery.position",    (payload) => { /* ... */ });
socket.on("task.assigned",        (payload) => { /* ... */ });
```

Server emits with `io.to("<room>").emit("<event.name>", payload)`. Heartbeat is handled by socket.io (`pingInterval = WS_HEARTBEAT_SEC`); clients don't send manual pings.

### 6.4 Channels & permitted events (full table)

| Channel format            | Subscriber                                | Events                                                                                                                                                                |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer:<userId>`       | the customer                              | `order.status_changed`, `order.cancelled`, `delivery.position`, `payment.captured`, `payment.failed`, `payment.refunded`                                              |
| `restaurant:<restId>`     | restaurant owner                          | `order.created`, `order.cancelled`                                                                                                                                    |
| `branch:<branchId>`       | restaurant manager / staff (member)       | `order.created`, `order.status_changed`, `order.cancelled`                                                                                                            |
| `agent:<agentId>`         | the agent                                 | `task.offered`, `task.assigned`, `task.taken`, `task.cancelled`                                                                                                       |
| `admin`                   | `system_admin`                            | `assignment.stalled`                                                                                                                                                  |

Every event is published by the service that made the transition, immediately
after its transaction commits. There is no separate event-wiring phase.

Payload shapes for events follow the response DTOs already defined (e.g. `order.status_changed.payload === { orderPublicId, status, updatedAt }`).

---

## 7. Health

### 7.1 GET /api/health

No auth. Returns 200 `OK` if DB ping succeeds, 500 otherwise. Mirrors core-service.

---

## 8. Internal endpoints (not for clients)

This service exposes **no** internal HTTP endpoints for inter-service traffic.

Async traffic from `core-service` (cache invalidation) arrives over **RabbitMQ**, not HTTP. See `system-design.md` §5 for topology, `database-design.md` §3.12 for the dedupe log. Message envelope:

```jsonc
{
  "eventId": "<uuid, stable across broker redeliveries>",
  "eventType": "product.stock.changed",
  "occurredAt": "2026-04-16T15:00:00.000Z",
  "payload": { /* event-specific */ }
}
```

This service does **not** emit any outbound events to anyone in this milestone.

---

## 9. Error codes (canonical)

| Code                              | HTTP | Module        |
| --------------------------------- | ---- | ------------- |
| `OrderNotFound`                   | 404  | orders        |
| `OrderNotPendingPayment`          | 409  | orders        |
| `BranchNotAcceptingOrders`        | 409  | orders        |
| `OutOfStock`                      | 409  | orders        |
| `IdempotencyConflict`             | 409  | shared        |
| `InvalidStatusTransition`         | 409  | orders        |
| `CancellationWindowExpired`       | 409  | orders        |
| `OrderNotReady`                   | 409  | deliveries    |
| `OrderAlreadyAssigned`            | 409  | deliveries    |
| `NotYourDelivery`                 | 403  | deliveries    |
| `CannotUnclaimAfterPickup`        | 409  | deliveries    |
| `NoEligibleAgents`                | 409  | deliveries    |
| `MaxAssignmentAttemptsReached`    | 409  | deliveries    |
| `AgentNotFound`                   | 404  | deliveries    |
| `AgentInActiveDelivery`           | 409  | agents        |
| `NotOnline`                       | 409  | agents        |
| `InsufficientBalance`             | 409  | finance       |
| `InvalidSignature`                | 401  | payments      |
| `Core service unavailable`        | 503  | shared        |
| `Payment provider unavailable`    | 503  | payments      |
| `User not authenticated`          | 401  | shared        |
| `User not authorised`             | 403  | shared        |

All thrown via `errors.ts` files in each module — no ad-hoc strings.

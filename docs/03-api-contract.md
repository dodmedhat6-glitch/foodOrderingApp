# API Contract — Orders & Payments Service

> Base path: `/api` (no version segment, matching core-service's confirmed convention — see
> `05-folder-structure.md` §7). Auth: same httpOnly-cookie JWT session as core-service
> (`access_token` cookie) — **this service verifies tokens issued by core-service; it never
> issues its own.** See §0. All monetary amounts in responses are serialized as **minor units**
> (`*Minor`, integer) — the client applies its own currency-aware decimal formatting; we never
> emit a floating-point money field. All `bigint` ids are serialized as **strings**. Incentives
> are explicitly out of scope (per updated requirements) — no discount/promo fields appear
> anywhere in this contract.
>
> Every endpoint below returns the standard envelope from `05-folder-structure.md` §4:
> `{ success: true, data, meta? }` or `{ success: false, data: { message, code? } }`. Only the
> `data` shape is documented per-endpoint below.

## 0. Auth, actors, and RBAC model

| Actor (`SystemRole` from core-service) | Used on |
|---|---|
| `customer` | order placement, own order/payment reads, order history |
| `restaurant_user` (scoped by `restaurantRole` + `restaurantId` + `branchIds`, same RBAC model as core-service) | restaurant order ops, restaurant finance views |
| `delivery_agent` | presence, tasks, delivery status updates, earnings |
| `system_admin` | everything; payments lookup by id; manual delivery assignment/reassignment; all admin overrides |

- **Authentication**: `authenticate` middleware (verifies the `access_token` cookie JWT). Since
  the token is issued by core-service, order-service needs the **same JWT verification secret**
  (or a JWKS/public-key if core-service moves to asymmetric signing later) — this is a
  cross-service config dependency, tracked in `AGENTS.md`.
- **RBAC**: reuses the exact `rbac({resource, action})` / `requireRestaurantMember` /
  `requireBranchAccess` middleware shape from core-service (see `05-folder-structure.md` §2.1 for
  why the *implementation* of "does this role have this permission" is injected via an interface
  rather than imported directly from core-service's code). New resource strings for this
  service's own permissions: `orders:*`, `deliveries:*`, `payments:*`, `restaurant-finance:*`.
- **Idempotency**: `Idempotency-Key` header, required (`strict: true`) on every state-mutating
  endpoint marked **(idempotent)** below. Same middleware shape as core-service's
  `lib/Idempotency`, backed by this service's own `idempotency_keys` table +
  Redis (see `02-database-design.md` §3.10), **with the core-service gap fixed**: the key is
  additionally scoped by a hash of the request body, so re-using a key with a different payload
  is a `409`, not a silent wrong-response replay.
- **Pagination**: cursor-based, matching core-service's `PaginationMeta` shape:
  `meta: { nextCursor: string | null, hasMore: boolean, count: number }`.

## 1. Orders module (`app/orders`)

### `POST /orders` — place an order **(idempotent)**

Auth: `customer`. Headers: `Idempotency-Key` (required).

**Request DTO** (`CreateOrderDto`):
```ts
{
  branchId: string;              // core-service branch id
  customerAddressId: string;     // core-service address id
  paymentMethod: "ONLINE" | "COD";
  items: Array<{
    productId: string;
    quantity: number;            // > 0
  }>;
  notes?: string;                // optional customer note, max 500 chars
}
```

**Validation / business rules** (see `04-modules/orders.md` for full detail):
- `items` non-empty; every `productId` must belong to `branchId`'s restaurant and be currently
  available (sync check against core-service, cached briefly).
- Server computes `subtotalMinor`/pricing from core-service's product prices **at request time**
  — client-supplied prices are never trusted, even if a mobile client caches them.
- `region`/`countryCode` resolved server-side from the branch (determines the shard — see
  `01-system-design.md` §7.2).
- Resulting order starts at `status = PENDING_PAYMENT` if `paymentMethod = ONLINE`, or
  `PLACED` immediately if `COD`.

**Response DTO** (`OrderResponseDto`, `201`):
```ts
{
  id: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  paymentMethod: "ONLINE" | "COD";
  restaurantId: string;
  branchId: string;
  items: Array<{
    id: string;
    productId: string;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
  }>;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  serviceFeeMinor: number;
  totalMinor: number;
  currency: string;
  deliveryAddressTextSnapshot: string;
  paymentSessionUrl: string | null;  // present only when paymentMethod = ONLINE — see payments module
  createdAt: string;                 // ISO-8601
}
```

**Errors**: `400` invalid items/address/branch, `404` branch/product not found, `409` idempotency
key reused with a different body, `422` product unavailable.

### `GET /orders/{orderId}` — fetch a single order

Auth: `customer` (own order only), `restaurant_user` (own restaurant's order, branch-scoped),
`system_admin`, or `delivery_agent` (only if currently assigned to it).

**Response DTO**: `OrderResponseDto` (§ above) plus delivery summary if applicable:
```ts
{
  ...OrderResponseDto,
  delivery: {
    status: DeliveryStatus;
    currentAgentId: string | null;
    assignedAt: string | null;
    pickedUpAt: string | null;
    deliveredAt: string | null;
  } | null;   // null until the order reaches READY_FOR_PICKUP
  rejectionReason: string | null;
  cancellationReason: string | null;
}
```

**Errors**: `403` not the owning customer/restaurant/agent, `404` not found.

### `GET /customer/orders?year=YYYY` — customer order history

Auth: `customer` (own orders only). Query: `year` (required, 4-digit), cursor pagination
(`cursor`, `limit` — default/max per `AGENTS.md` performance rules).

Routing: current year → home-region hot partition; other years → archive path; if the customer
has cross-region activity, fan out per `01-system-design.md` §7.3 and merge by `createdAt desc`
before applying the cursor.

**Response**: `data: OrderListItemResponseDto[]`, `meta: PaginationMeta`.
```ts
// OrderListItemResponseDto — a deliberately smaller shape than OrderResponseDto (list views
// never return line items, matching the "no N+1 / no over-fetching" rule in AGENTS.md)
{
  id: string;
  restaurantId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  totalMinor: number;
  currency: string;
  createdAt: string;
}
```

## 2. Restaurant order operations (`app/orders`, RBAC + branch-scoped)

### `GET /restaurant/orders?branchId=&status=&from=&to=`

Auth: `restaurant_user` — `requireRestaurantMember`, and if `branchId` given, `requireBranchAccess`.
If `branchId` omitted, results are scoped to every branch the caller has access to
(`req.user.branchIds`), never restaurant-wide for a branch-scoped staff/manager role.

Query params: `branchId?`, `status?` (`OrderStatus`), `from?`/`to?` (ISO date, filters
`createdAt`), cursor pagination.

**Response**: `data: OrderListItemResponseDto[]` (same shape as §1, since a restaurant board is
also a list view — never line items here either; use `GET /orders/{orderId}` to drill in),
`meta: PaginationMeta`.

> This is the query the audit's raw-SQL guidance in `01-system-design.md` §3/§6 applies to most
> directly — it's polled frequently by restaurant dashboards. Backed by
> `idx_orders_branch_status_created` (`02-database-design.md` §3.1); implemented with the query
> builder first, moved to raw SQL only if profiling shows it's warranted.

### `PATCH /orders/{orderId}/status` — single endpoint for accept / reject / prep / ready

Auth: `restaurant_user` (`requireRestaurantMember` + `requireBranchAccess`) or `system_admin`
(manual override).

**Request DTO** (`UpdateOrderStatusDto`):
```ts
{
  action: "ACCEPT" | "REJECT" | "START_PREPARING" | "MARK_READY" | "CANCEL";
  reason?: string;   // required when action = REJECT or CANCEL
}
```

`action` is an explicit verb, not a raw target status — the service layer maps each verb to the
one legal `orders.status` transition it represents and rejects anything else with `409`
("illegal transition"). See `04-modules/orders.md` for the full state machine table. This keeps
the single-PATCH-endpoint requirement from the spec while avoiding "just PATCH `status` to
whatever string you want" (which would let a client skip states or write an invalid one).

**Response DTO**: `OrderResponseDto` (updated).

**Errors**: `409` illegal transition for current status, `400` missing `reason` for
`REJECT`/`CANCEL`, `403` not authorized for this branch/restaurant.

## 3. Payments module (`app/payments`)

See `07-kashier-integration.md` for the full provider-integration detail this section's fields
are derived from.

### `POST /payments/init` — start payment for an order **(idempotent)**

Auth: `customer` (must own the order). Headers: `Idempotency-Key` (required).

**Request DTO** (`InitPaymentDto`):
```ts
{
  orderId: string;
  provider?: "KASHIER";   // optional; defaults to the highest-priority enabled provider for the order's currency/region
}
```

**Business rules**: order must be `paymentMethod = ONLINE` and `paymentStatus = PENDING`; creates
a `transactions` row (`transaction_type = ORDER_PAYMENT`, `status = PENDING`) **before** calling
the provider, then calls Kashier to create a payment session. If the order is `COD`, this
endpoint returns `422` — COD orders never call this endpoint.

**Response DTO** (`PaymentInitResponseDto`, `201`):
```ts
{
  transactionId: string;
  orderId: string;
  provider: "KASHIER";
  status: "PENDING";
  amountMinor: number;
  currency: string;
  paymentSessionUrl: string;   // Kashier's sessionUrl — client redirects/embeds this
}
```

**Errors**: `404` order not found/not owned, `409` idempotency key reused with different body /
order already paid, `422` order is COD or not in a payable state, `502` provider unreachable.

### `POST /payments/webhook/{provider}` — provider callback

Auth: **none (public endpoint)** — authenticity is established by verifying the provider's own
signature (`x-kashier-signature`, see `07-kashier-integration.md` §4), not by our session/JWT
auth. `{provider}` path param (e.g. `kashier`) selects which adapter/signature scheme to apply,
so this route can support additional providers later without a new top-level route.

**Request body**: raw provider payload, passed through to the provider-specific adapter
unmodified — **not** wrapped in our own DTO on the way in (we don't control the shape Kashier
sends). The adapter (`pkg/kashier/types.ts`) parses it into an internal, provider-agnostic
`PaymentEvent` shape before it ever reaches `app/payments` business logic.

**Response**: **no envelope** — this endpoint deliberately does not use the standard
`{success, data}` shape, because the caller is Kashier's retry engine, not a DODS client. It
returns bare `200` (processed) or `409` (already processed / duplicate), per
`07-kashier-integration.md` §4.1. Any other status triggers a Kashier retry, which is the desired
behavior for a transient failure on our end.

### `GET /payments/{paymentId}` — payment lookup (admin/support/internal)

Auth: `system_admin`, or the owning `customer`/restaurant (`restaurant_user` for their own
restaurant's payments), or an internal service-to-service call (future — tracked as TBD until
there's a second internal caller).

**Response DTO** (`PaymentResponseDto`):
```ts
{
  id: string;
  orderId: string | null;
  transactionType: TransactionType;
  method: TransactionMethod;
  provider: string | null;
  providerReferenceId: string | null;
  status: TransactionStatus;
  amountMinor: number;
  currency: string;
  srcAccId: string | null;   // null = SYSTEM
  dstAccId: string | null;   // null = SYSTEM
  isRefunded: boolean;
  createdAt: string;
  updatedAt: string;
}
```

`metadata` (raw provider payload) is **never** included in this response — it's for internal
audit/debugging only, accessed directly against the DB/admin tooling, not exposed over the API
(avoids ever leaking a provider's raw response fields, including any it might add later, into a
client-facing contract).

## 4. Delivery assignment & lifecycle (`app/delivery-agent`)

### `POST /deliveries/assign/{orderId}` — manual trigger (system also triggers automatically)

Auth: `system_admin`, or automatic internal call from the order-status service when an order
becomes `READY_FOR_PICKUP` (not a public route in that case — internal service call, same
process, no HTTP hop).

**Request DTO**: none required for the automatic path. For **manual** admin-triggered assignment:
```ts
{ agentId?: string }   // optional explicit agent; omitted = automatic proximity+availability pick
```

**Response DTO** (`DeliveryResponseDto`, `200`):
```ts
{
  orderId: string;           // == deliveryId, see 02-database-design.md §3.5
  status: DeliveryStatus;
  currentAgentId: string | null;
  attemptCount: number;
  assignedAt: string | null;
}
```

**Errors**: `404` order not found or not `READY_FOR_PICKUP`, `409` already assigned, `422` no
agent available (falls back to a queued/unassigned state, not a hard failure — see
`04-modules/delivery-agent.md`).

### `POST /deliveries/reassign/{orderId}` — retry with a new agent

Auth: `system_admin`, `restaurant_user` (`requireRestaurantMember`), or automatic internal call
after a rejection/timeout.

**Request DTO**: `{ reason?: string }` (optional, for the `delivery_assignment_attempts` audit
trail).

**Business rule**: increments `deliveries.attempt_count`; if it exceeds the configured max
retries, sets `deliveries.status = FAILED` and returns `409` instead of attempting another
assignment — surfaced to admin dashboards for manual handling.

**Response DTO**: `DeliveryResponseDto` (same shape as above).

## 5. Agent presence (`app/delivery-agent`)

All three below: Auth `delivery_agent` (self only — no `agentId` in the body; always
`req.user.user_id`).

### `POST /agents/presence/online`
### `POST /agents/presence/offline`

No request body. Writes `agent_presence.status` synchronously (low frequency, fine to hit
Postgres directly — see `02-database-design.md` §3.9). Also updates the Redis presence set
(`agents:geo:{region}`) — added on `online`, removed on `offline`.

**Response DTO**: `{ status: "ONLINE" | "OFFLINE", updatedAt: string }`.

### `POST /agents/presence/ping`

**Request DTO**: `{ lat: number, lng: number }`.

Writes Redis (`agents:geo:{region}` GEOADD + `agents:lastseen:{agentId}`) synchronously on every
call; writes `agent_presence` in Postgres **throttled** (see `02-database-design.md` §3.9/§7.3) —
not on every ping.

**Response DTO**: `{ acknowledgedAt: string }`.

**Errors**: `409` if agent is not currently `ONLINE` (must call `/online` first).

## 6. Agent tasks + actions (`app/delivery-agent`)

### `GET /agents/tasks?status=`

Auth: `delivery_agent` (self only). Query: `status?` (`DeliveryStatus`, defaults to
`ASSIGNED,PICKED_UP` — i.e. "active" tasks — when omitted).

**Response**: `data: AgentTaskResponseDto[]`
```ts
{
  orderId: string;              // == deliveryId
  restaurantId: string;
  branchId: string;
  pickupAddress: string;        // resolved from branch (sync, cached — core-service lookup)
  deliveryAddressTextSnapshot: string;
  deliveryLat: number;
  deliveryLng: number;
  status: DeliveryStatus;
  assignedAt: string;
}
```

Backed by `idx_deliveries_agent_status` (`02-database-design.md` §3.5); joined with `orders` for
the address/branch fields in a single query (no N+1 across tasks — see `AGENTS.md`).

### `PATCH /deliveries/{deliveryId}/status` — accept / pickup / deliver

Auth: `delivery_agent` — must be `deliveries.current_agent_id` for this `deliveryId` (except
`ACCEPT`, which is legal for the agent named in the **most recent outstanding**
`delivery_assignment_attempts` row for this order, before they become `current_agent_id`).

**Request DTO** (`UpdateDeliveryStatusDto`):
```ts
{
  action: "ACCEPT" | "REJECT" | "PICKUP" | "DELIVER";
}
```

Same "verb, not raw status" pattern as `PATCH /orders/{orderId}/status` (§2), for the same
reason. `ACCEPT`/`REJECT` resolve the outstanding `delivery_assignment_attempts` row;
`PICKUP`/`DELIVER` advance `deliveries.status` and, on `DELIVER`, atomically (same DB transaction):
sets `orders.status = DELIVERED`, inserts the `agent_earnings` row, and is the trigger point for
`restaurant_balances` to be credited (`transactions.transaction_type = ORDER_PAYMENT` settlement
— see `04-modules/restaurant-finance.md` for the exact ledger entries created here).

**Response DTO**: `DeliveryResponseDto` (§4), extended with `pickedUpAt`/`deliveredAt` as
applicable.

**Errors**: `409` illegal transition, `403` not the assigned agent.

## 7. Earnings (`app/delivery-agent`)

### `GET /agents/earnings?from=&to=`

Auth: `delivery_agent` (self only), `system_admin`.

Query: `from`/`to` (ISO date, required — no unbounded "all time" query, per the performance rules
in `AGENTS.md`), cursor pagination.

**Response**: `data: AgentEarningResponseDto[]`, `meta: PaginationMeta` plus a lightweight summary:
```ts
{
  items: Array<{
    orderId: string;
    amountMinor: number;
    currency: string;
    earnedAt: string;
  }>,
}
// meta additionally carries: { totalAmountMinor: number, currency: string } for the queried range
```

Backed by `idx_earnings_agent_earned` (`02-database-design.md` §3.7); the range total is computed
in the same query (`SUM(...) OVER()` or a paired aggregate query), not by summing in application
code across paginated pages.

## 8. Restaurant finance views (`app/restaurant-finance`, read-only)

### `GET /restaurant/balance`

Auth: `restaurant_user` (owner/manager — `resource: "restaurant-finance:balance", action: "read"`),
`requireRestaurantMember`.

**Response DTO** (`RestaurantBalanceResponseDto`):
```ts
{
  restaurantId: string;
  balanceMinor: number;
  currency: string;
  updatedAt: string;
}
```

Direct point read of `restaurant_balances` by PK — no computation, no joins.

### `GET /restaurant/payouts?from=&to=`

Auth: `restaurant_user` (owner only per PRD — "View payout history" is listed under Owner
Permissions specifically, not Manager), `requireRestaurantMember`.

Query: `from`/`to` (ISO date, required), cursor pagination.

**Response**: `data: PayoutHistoryItemResponseDto[]`
```ts
{
  transactionId: string;
  amountMinor: number;
  currency: string;
  status: TransactionStatus;      // PENDING | PROCESSING | SUCCESS | FAILED | REVERSED
  providerReferenceId: string | null;
  createdAt: string;
}
```

This reads `transactions WHERE dst_acc_id = :ownerUserId AND transaction_type = 'PAYOUT'`
(backed by `idx_txn_dst_type_created`, `02-database-design.md` §3.3) — **read-only**; this module
never writes to `transactions` (see the one-writer-per-table rule in `05-folder-structure.md` §8).

## 9. Endpoint summary table

| Method & Path | Module | Auth | Idempotent |
|---|---|---|---|
| `POST /orders` | orders | customer | ✅ |
| `GET /orders/{orderId}` | orders | customer/restaurant/agent/admin (owner-scoped) | — |
| `GET /customer/orders?year=` | orders | customer | — |
| `GET /restaurant/orders?...` | orders | restaurant_user | — |
| `PATCH /orders/{orderId}/status` | orders | restaurant_user/admin | — (guarded by state machine instead) |
| `POST /payments/init` | payments | customer | ✅ |
| `POST /payments/webhook/{provider}` | payments | provider signature | idempotent by construction (§4.2 of Kashier doc) |
| `GET /payments/{paymentId}` | payments | admin/owner-scoped | — |
| `POST /deliveries/assign/{orderId}` | delivery-agent | admin/system | — |
| `POST /deliveries/reassign/{orderId}` | delivery-agent | admin/restaurant/system | — |
| `POST /agents/presence/online` | delivery-agent | agent (self) | — |
| `POST /agents/presence/offline` | delivery-agent | agent (self) | — |
| `POST /agents/presence/ping` | delivery-agent | agent (self) | — |
| `GET /agents/tasks?status=` | delivery-agent | agent (self) | — |
| `PATCH /deliveries/{deliveryId}/status` | delivery-agent | agent (assigned) | — (guarded by state machine) |
| `GET /agents/earnings?from=&to=` | delivery-agent | agent (self)/admin | — |
| `GET /restaurant/balance` | restaurant-finance | restaurant_user | — |
| `GET /restaurant/payouts?from=&to=` | restaurant-finance | restaurant_user (owner) | — |

# Database Design — `order_service`

Postgres 15+, sharded per region. No PostGIS, and no agent-presence table at all — presence lives only in Redis (§3.8).

This document specifies every table this service owns, its columns, FKs (in-shard only — see §Cross-service references), indexes (each justified by a query), and the sharding plan.

The schema diverges from the rough draft in `img_2.png` per project guidance:
- **No `payouts` table.** Payouts are recorded as a row in `transactions` with `transaction_type='payout'`.
- **Money columns are `INT` minor units**, not `DECIMAL` (see CLAUDE.md §7).
- `src_acc_id` / `dst_acc_id` reference `core_service.users.id` (logical, no FK). For restaurants, use the **owner user id**. For platform-side rows (commission, refund-from-platform), `src_acc_id` is `NULL` to denote SYSTEM.
- **No `incentives` tables.**
- **No `events_outbox` table.** This service does not emit outbound async events in this milestone (no analytics consumer; no other consumer needs it). Async with core-service is inbound-only — see `docs/system-design.md` §5.
- **No `customer_order_index` table.** With country-level shards (one DB per country), customers ordering across regions are rare; if/when needed, the cross-region history view will be implemented as a fan-out at the controller level. Removed to keep the milestone surface area small.
- **No `deliveries` table.** The draft in `img_2.png` is right: a delivery is not an
  entity with a life of its own, it is a phase of an order. `orders` already carries
  `delivery_agent_id`, `assigned_at`, `picked_at`, `delivered_at`, `delivery_lat/lng` and
  the `assigned|picked|delivered` statuses, and the assignment scan and agent task list
  both have indexes on it already. A second table would duplicate every one of those
  columns, add a join to the hottest agent-facing read, and — because `orders` is
  partitioned and its PK is `(id, created_at)` — could not even hold a real FK back to
  the order. See s3.7.
- **No `agent_presence` table.** Presence is a fact with a five-minute
  lifetime — where an agent was, last time their phone said so. Persisting it
  buys nothing: nobody queries yesterday's location, the row is overwritten
  every 30 seconds, and a durable copy of a value that is wrong after five
  minutes is just a slower cache. It lives in Redis, with `GEO` as the spatial
  index, and is allowed to disappear (§3.8).
- New tables added: `idempotency_keys`, `payment_sessions`, `payment_webhook_events`. **No `core_inbound_events`** — inbound-event dedupe lives in Redis (`core-events:dedupe:<eventId>`, SETNX, 24h TTL), not SQL.

---

## 0. Conventions

- Every table has `id BIGSERIAL PRIMARY KEY` unless noted.
- Every sharded table has `region TEXT NOT NULL` immediately after `id`.
- `created_at`, `updated_at` are `TIMESTAMP NOT NULL DEFAULT NOW()` for hot rows. Status-transition timestamps (`accepted_at`, `picked_at`, etc.) are `TIMESTAMP NULL` until the transition happens.
- Money columns are `INT NOT NULL` storing minor units. A `currency` column lives next to them or on the parent (`orders.currency`).
- Enum-like columns are `TEXT NOT NULL CHECK(col IN ('a','b'))` (matches core-service convention). Native PG `ENUM` is reserved for `currency_enum` which already exists in core.
- Index naming: `idx_<table>_<col>[_<col>]`. Constraint naming: `fk_<table>_<col>`, `uq_<table>_<col>`.
- Every FK has a supporting btree index (Postgres does not auto-index FK columns).

---

## 1. Cross-service references (logical, no DB FK)

| Logical reference         | Where in this service                                | Source of truth     |
| ------------------------- | ---------------------------------------------------- | ------------------- |
| `users.id`                | `orders.customer_id`, `orders.delivery_agent_id`, `transactions.src_acc_id`, `transactions.dst_acc_id`, `agent_earnings.agent_id` | `core-service.users` |
| `customer_addresses.id`   | `orders.customer_address_id`                         | `core-service.customer_addresses` |
| `restaurants.id`          | `orders.restaurant_id`, `restaurant_balances.restaurant_id` | `core-service.restaurants` |
| `restaurant_branches.id`  | `orders.branch_id`                                   | `core-service.restaurant_branches` |
| `products.id`             | `order_items.product_id`                             | `core-service.products` |

These are validated **at write time** via the `core-client` (sync HTTP) when the data is not already proven (e.g. by JWT claims or a recent cache hit). For repeatedly hot lookups (branch metadata, product price/stock), we maintain a Redis read-through cache populated from `core-service`.

We snapshot critical fields at order time (`order_items.name_snapshot`, `unit_price_snapshot`, `image_url_snapshot`) so historical orders remain readable even after the source row changes or is deleted.

---

## 2. Sharding plan

### Shard key: country

The shard key is the **country code**: `eg`, `sa`, ... — one Postgres cluster per country. The DB column is named `region` so the router stays generic if we ever sub-shard a country later, but in this milestone `region == country code`.

### Resolution

For every request, the region is resolved (in order):
1. Path/query: explicit `?region=` (admin endpoints; `region=all` permitted on fan-out reads only).
2. Header: `X-Region` (gateway-supplied or client-supplied on guest checkout).
3. Cookie: `region=<code>`.
4. For customer order placement: derived from the chosen `branchId` — branches are tied to a country in `core-service`.

Region is **not** a JWT claim (we dropped it — keeps tokens stateless per shard decision).

A `lib/sharding/router.ts` returns a `Knex` instance for the resolved region. All repository functions accept the connection as the last argument (already the convention in core-service for `trx`, we extend it):

```ts
export async function findOrderById(id: number, conn: Knex): Promise<OrderEntity | undefined> { ... }
```

There is no fallback "global" connection in business code. Migrations iterate over the configured regions list.

### Read replicas

Not introduced in this milestone. All reads and writes go to the primary per region. We will revisit when traffic justifies adding replicas.

### Cross-shard reads

Forbidden in the hot path. The only handled case is:
1. **System-admin global views** (e.g. all pending orders across countries) — fan-out at the controller level, sequential, with hard pagination per shard. With ~2 countries today (`eg`, `sa`) this is cheap.

### Tables that ARE sharded

`orders`, `order_items`, `transactions`, `restaurant_balances`, `agent_earnings`, `idempotency_keys`, `payment_sessions`, `payment_webhook_events`.

### Tables that ARE NOT sharded (replicated to every shard, or live once)

`payment_providers` — small lookup, replicated. Treat as read-only seed. The *schema* is on every shard; the *rows* are per-region (see s3.3).

### Cold archive (Phase 5)

A separate Postgres cluster per region (`order_service_archive`) holds rows older than the current year. Same schema as the hot DB. The archival worker copies and deletes — see `docs/implementation-plan.md` Phase 5.

---

## 3. Tables

### 3.1 `orders`

Primary write target of this service. Holds the order header.

```sql
CREATE TABLE orders (
    id              BIGSERIAL PRIMARY KEY,
    region          TEXT NOT NULL,                                -- shard key
    public_id       UUID NOT NULL UNIQUE,                         -- client-facing id
    country_code    TEXT NOT NULL,
    restaurant_id   BIGINT NOT NULL,                              -- logical FK -> core.restaurants.id
    branch_id       BIGINT NOT NULL,                              -- logical FK -> core.restaurant_branches.id
    customer_id     BIGINT NOT NULL,                              -- logical FK -> core.users.id
    customer_address_id BIGINT NOT NULL,                          -- logical FK -> core.customer_addresses.id
    -- delivery snapshot (so the address survives after the customer edits/deletes it)
    delivery_lat    DECIMAL(10,7) NOT NULL,
    delivery_lng    DECIMAL(10,7) NOT NULL,
    delivery_address_text_snapshot TEXT NOT NULL,
    -- status machine
    status          TEXT NOT NULL CHECK (status IN (
                        'pending_payment','placed','accepted','rejected',
                        'preparing','ready','assigned','picked','delivered','cancelled'
                    )),
    -- money (minor units)
    subtotal        INT NOT NULL,
    delivery_fee    INT NOT NULL,
    service_fee     INT NOT NULL,
    total           INT NOT NULL,                                 -- subtotal + delivery_fee + service_fee
    commission      INT NOT NULL DEFAULT 0,                       -- platform cut, computed at delivery
    currency        TEXT NOT NULL,                                -- 'EGP','SAR'
    payment_method  TEXT NOT NULL CHECK (payment_method IN ('online','cod')),
    -- delivery
    delivery_agent_id BIGINT,                                     -- nullable until assigned
    -- timestamps
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    accepted_at     TIMESTAMP NULL,
    rejected_at     TIMESTAMP NULL,
    ready_at        TIMESTAMP NULL,
    assigned_at     TIMESTAMP NULL,
    picked_at       TIMESTAMP NULL,
    delivered_at    TIMESTAMP NULL,
    cancelled_at    TIMESTAMP NULL
);

-- supports GET /orders/{publicId} and the branch-scoped copy    (restaurant_id/branch_id are filters on top, not index terms)
CREATE INDEX idx_orders_public_id ON orders (public_id);
-- supports GET /customer/orders?year=YYYY                       (customer history, current year hot)
CREATE INDEX idx_orders_customer_id_created_at ON orders (customer_id, created_at DESC);
-- supports GET /restaurants/{rid}/branches/{bid}/orders?status=&from=&to=  (most queried — restaurant ops dashboard)
CREATE INDEX idx_orders_branch_status_created_at ON orders (branch_id, status, created_at DESC);
-- supports DELIVERY assignment scan for pending assignment in a region
CREATE INDEX idx_orders_status_created_at ON orders (status, created_at) WHERE status IN ('ready','assigned');
-- supports GET /agents/tasks?status=
CREATE INDEX idx_orders_delivery_agent_id_status ON orders (delivery_agent_id, status) WHERE delivery_agent_id IS NOT NULL;
```

Notes:
- `public_id` (UUID) is what we expose. The bigint `id` stays internal.
- `total` is denormalized for read efficiency; recomputed and asserted at insert and on any line-item change.
- We store `delivery_address_text_snapshot` and lat/lng on the order so the order remains coherent if the user later deletes the saved address.

---

### 3.2 `order_items`

```sql
CREATE TABLE order_items (
    id                  BIGSERIAL PRIMARY KEY,
    region              TEXT NOT NULL,
    order_id            BIGINT NOT NULL,
    product_id          BIGINT NOT NULL,                          -- logical FK -> core.products.id
    quantity            INT NOT NULL CHECK (quantity > 0),
    unit_price_snapshot INT NOT NULL,                             -- minor units, frozen at order time
    name_snapshot       TEXT NOT NULL,
    image_url_snapshot  TEXT NULL,
    line_total          INT NOT NULL,                             -- quantity * unit_price_snapshot
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_order_items_order_id FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- supports GET /orders/{orderId} expansion (single batch fetch via whereIn for lists)
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
-- (no product_id index — we never query items by product in this service; analytics service will)
```

---

### 3.3 `payment_providers` (lookup, NOT sharded — same data on every shard)

```sql
CREATE TABLE payment_providers (
    id          INT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,                              -- 'kashier'
    is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    priority    SMALLINT NOT NULL DEFAULT 100
);

-- seeded:
-- (1, 'kashier', true, 10)
```

Only **external gateways** live here. Cash on delivery is a payment *method*,
not a provider — there is no gateway behind it — so it is expressed as
`transactions.method = 'cod'` / `orders.payment_method = 'cod'` with
`transactions.provider_id` left NULL. See s3.5.

The table is replicated in **schema**, not in **rows**: a gateway is seeded only
on the shards where it can actually take money, so `kashier` exists on `eg`
only. Ids stay globally assigned so the same number means the same provider
everywhere, which is what cross-region reporting on `provider_id` relies on. A
shard with no row for the configured adapter makes `providerIdOf` throw, which
is the intended signal that the region has no online rail yet — COD is
unaffected, since it never resolves a provider.

No indexes beyond PK + the unique on `name`. Tiny lookup table.

---

### 3.4 `payment_sessions` (Kashier session lifecycle)

A Kashier "Payment Session" is created before redirecting the customer. We store the local mirror so we can correlate webhook events.

```sql
CREATE TABLE payment_sessions (
    id              BIGSERIAL PRIMARY KEY,
    region          TEXT NOT NULL,
    order_id        BIGINT NOT NULL,
    provider_id     INT NOT NULL,                                 -- FK to payment_providers (logically — providers replicated)
    order_public_id UUID NOT NULL,                                -- added: UUIDv7, prunes the partition scan on settle
    merchant_order_ref TEXT NOT NULL,                             -- added: '<region>_<publicId>_<attempt>'; the webhook's only handle
    provider_session_id TEXT NOT NULL,                            -- Kashier's session id
    provider_order_id TEXT NULL,                                  -- added: Kashier's order id, learned from the first webhook; the refund endpoint is keyed by it
    redirect_url    TEXT NOT NULL,
    amount          INT NOT NULL,                                 -- minor units
    currency        TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN (
                        'initialized','pending','authorized','captured','failed','expired','cancelled'
                    )),
    raw_init_payload  JSONB NOT NULL,                             -- what we sent to Kashier
    raw_last_payload  JSONB NULL,                                 -- last update from Kashier
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

    -- NO FK to orders: it is RANGE-partitioned, and a FK into a partitioned
    -- table needs a unique index containing the partition key. Logical
    -- reference only, same as order_items.
    CONSTRAINT uq_payment_sessions_provider_session_id UNIQUE (provider_session_id),
    CONSTRAINT uq_payment_sessions_merchant_order_ref UNIQUE (merchant_order_ref)
);

-- supports order -> session lookup (init re-use, refund, order detail)
CREATE INDEX idx_payment_sessions_order_id ON payment_sessions (order_id);
-- supports the expiry sweep
CREATE INDEX idx_payment_sessions_status_expires_at ON payment_sessions (status, expires_at)
    WHERE status IN ('initialized','pending','authorized');
-- (no index on provider_session_id or merchant_order_ref: the unique
--  constraints above already provide one each)
```

> **As built.** `expires_at TIMESTAMP NOT NULL` was added as well — it is what
> `POST /payments/init` returns and what the sweep scans. The webhook does
> *not* look a session up by `provider_session_id`: Kashier's payload carries
> no session id, only the `merchantOrderId` we chose. See
> `docs/business-logic/payments.md` §2, "The merchant order reference".

---

### 3.5 `transactions`

The money ledger. Every money movement is one row. Includes payments, refunds, commissions, and **payouts** (so we don't need a separate `payouts` table).

```sql
CREATE TABLE transactions (
    id                  BIGSERIAL PRIMARY KEY,
    region              TEXT NOT NULL,
    order_id            BIGINT NULL,                              -- nullable for payouts not tied to an order
    order_public_id     UUID NULL,                                -- added: UUIDv7, so GET /payments/{id} can reach the order in one partition
    transaction_type    TEXT NOT NULL CHECK (transaction_type IN (
                            'charge','refund','commission','payout','cod_collection','adjustment'
                        )),
    method              TEXT NOT NULL CHECK (method IN ('online','cod','bank_transfer','system')),
    provider_id         INT NULL,                                 -- NULL for COD and for non-provider tx (commission, payout, adjustment)
    provider_reference_id TEXT NULL,                              -- Kashier txn id / bank ref
    status              TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','reversed')),
    amount              INT NOT NULL,                             -- minor units, always positive
    currency            TEXT NOT NULL,
    -- accounting (logical user ids in core)
    src_acc_id          BIGINT NULL,                              -- NULL => SYSTEM (platform)
    dst_acc_id          BIGINT NULL,                              -- NULL => SYSTEM
    -- refund linkage
    is_refunded         BOOLEAN NOT NULL DEFAULT FALSE,
    refunded_payment_id BIGINT NULL,
    -- idempotency from upstream (e.g. webhook event id)
    idempotency_key     TEXT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),

    -- NO FK to orders, for the same partitioning reason as payment_sessions.
    -- The self-reference below IS a real FK: transactions is not partitioned.
    CONSTRAINT fk_transactions_refunded_payment_id FOREIGN KEY (refunded_payment_id) REFERENCES transactions(id),
    CONSTRAINT uq_transactions_idempotency_key UNIQUE (idempotency_key)
);

-- supports GET /payments/{id} (admin lookup)
-- (PK lookup via id is the public id for transactions; no extra index needed)

-- supports order detail expansion (1 round trip per order's tx ledger)
CREATE INDEX idx_transactions_order_id ON transactions (order_id);
-- supports webhook idempotency lookup by provider reference
CREATE INDEX idx_transactions_provider_reference_id ON transactions (provider_reference_id) WHERE provider_reference_id IS NOT NULL;
-- supports restaurant payout history: GET /restaurant/payouts?from=&to=
CREATE INDEX idx_transactions_dst_acc_type_created_at ON transactions (dst_acc_id, transaction_type, created_at DESC) WHERE transaction_type = 'payout';
-- supports finance reconciliation by status + type
CREATE INDEX idx_transactions_type_status_created_at ON transactions (transaction_type, status, created_at DESC);
-- supports the self-FK above, and the refund-headroom sum per charge
CREATE INDEX idx_transactions_refunded_payment_id ON transactions (refunded_payment_id)
    WHERE refunded_payment_id IS NOT NULL;
```

> **As built.** `refunded_payment_id` is set on the **refund** row and points at
> the charge, which is what lets one charge carry several partial refunds.
> `is_refunded` is flagged on the charge only once those refunds reach its full
> amount — the remaining headroom is the sum, not the flag.

Why no separate `payouts` table:
- Same columns are needed (amount, currency, src/dst, provider ref, status, timestamps).
- One ledger to query; no JOIN; payout history is a filter on `transaction_type='payout'`.
- The unique constraint on `idempotency_key` lets us safely re-record a payout from an admin retry.

---

### 3.6 `restaurant_balances`

One row per (restaurant, currency) — restaurants may operate in multiple regions/currencies, but for now (single currency per restaurant) it's effectively one row per restaurant.

```sql
CREATE TABLE restaurant_balances (
    restaurant_id   BIGINT NOT NULL,
    region          TEXT NOT NULL,
    currency        TEXT NOT NULL,
    balance         INT NOT NULL DEFAULT 0,                       -- minor units
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (restaurant_id, currency)
);

-- balance is incremented on order delivered (subtotal - commission), decremented on payout.
-- single-row lookup by (restaurant_id, currency) is the only query — PK suffices.
```

Updates use `SELECT ... FOR UPDATE` inside the same transaction as the delivery state transition or payout insert.

---

### 3.7 The delivery lives on `orders` — there is no `deliveries` table

A delivery has no identity outside the order it delivers. There is exactly one
per order, it is created and destroyed with the order, and every column it would
hold is either already on `orders` or derivable from it:

| Would-be `deliveries` column  | Where it actually lives                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `order_id`                    | the row itself                                               |
| `agent_id`                    | `orders.delivery_agent_id`                                   |
| `status`                      | `orders.status` in (`ready`,`assigned`,`picked`,`delivered`) |
| `pickup_lat/lng`              | the branch projection (`core:branch:<id>`), read at assignment |
| `dropoff_lat/lng`             | `orders.delivery_lat` / `orders.delivery_lng`                |
| `assigned_at` … `delivered_at`| the matching `orders.<verb>_at` columns                      |
| `earning_amount`, `currency`  | `agent_earnings.amount`, `orders.currency`                   |

Three further reasons not to add the table:

1. **It could not hold a real FK.** `orders` is RANGE-partitioned and its PK is
   `(id, created_at)`, so any child must carry `created_at` too (CLAUDE.md §7).
   A `deliveries.order_id BIGINT REFERENCES orders(id)` does not compile.
2. **It would put a join on the hottest agent read.** `GET /agents/tasks` is
   polled by every online agent. Served from `orders` it is one index scan on
   `idx_orders_delivery_agent_id_status`; served from a join it is two.
3. **The reassignment chain it existed to record is not worth a table.** See the
   status model below — a reassignment is `delivery_agent_id = NULL` plus
   `status = 'ready'`, and the attempt count is a Redis counter with the order's
   lifetime. If an audit trail is ever required it belongs in a generic
   `order_status_history` covering *all* transitions, not a delivery-shaped one
   covering four of them.

#### Status model

The agent-facing lifecycle collapses into the order status machine that already
exists (`docs/business-logic/orders.md` §2):

```
ready ──(agent claims)──► assigned ──► picked ──► delivered
  ▲                           │
  └───(unclaim / reassign)────┘
```

There is **no separate agent-accept step**. In the `deliveries` draft an agent was
first `assigned` and then `accepted`; with offer-and-claim dispatch (see
`docs/business-logic/deliveries.md` §2) the claim *is* the assignment, so the two
states are one. That removes the accept timeout, the `rejected` delivery status
and the reassignment chain in a single stroke.

#### Exclusivity

One agent per order, and one active order per agent, are both enforced by
conditional UPDATEs on `orders` rather than by a second table:

```sql
-- claim: only one concurrent claimer can match
UPDATE orders SET status='assigned', delivery_agent_id=?, assigned_at=NOW(), updated_at=NOW()
WHERE id=? AND created_at=? AND status='ready' AND delivery_agent_id IS NULL;
-- 0 rows affected => somebody else won => 409 OrderAlreadyAssigned
```

```sql
-- an agent may hold at most one active order
SELECT 1 FROM orders
WHERE delivery_agent_id=? AND status IN ('assigned','picked') LIMIT 1;
-- backed by idx_orders_delivery_agent_id_status
```

---

### 3.8 Agent presence is Redis-only — there is no table

Presence answers one question — *which agents are near this branch right now* —
and the answer is worthless once it is five minutes old. That is the whole
argument: a durable row describing a position that has already expired is a
cache with extra steps and a migration.

So presence is held entirely in Redis, with no Postgres counterpart and no
write-through. **Losing it is a supported state**, not an incident: every agent
re-registers on their next ping, which is at most 30 seconds away.

#### Keys

| Key                                | Type     | TTL                 | Holds                                      |
| ---------------------------------- | -------- | ------------------- | ------------------------------------------ |
| `presence:geo:<region>`            | GEO (ZSET) | none (swept)      | every known agent's last coordinates        |
| `presence:meta:<region>:<agentId>` | HASH     | `PRESENCE_STALE_SEC` | `lastSeenAt`, `lat`, `lng`, and the active order (`orderId`, `orderPublicId`, `customerId`) while one is held |

Two keys, and the split is deliberate:

- **`GEO` is the spatial index.** `GEOSEARCH ... BYRADIUS ... ASC COUNT k`
  returns the k nearest members sorted by distance in one call — exactly the
  assignment query, served by a sorted set of geohashes rather than a table scan.
- **The meta hash's TTL *is* the freshness cutoff.** A GEO member cannot carry
  its own TTL (ZSET members never expire individually), so staleness is
  expressed by the one key that can expire. An agent who stops pinging has their
  meta key vanish after `PRESENCE_STALE_SEC`; the geo entry is then a tombstone
  that the candidate filter ignores and the sweep removes. Redis does the
  five-minute rule for us — nothing compares timestamps in application code.

#### Why no `presence:busy` set

An earlier draft kept a third key listing agents holding an order. It is
redundant: the active order is a field on the meta hash, written by the same
command that refreshes it, so busy-ness cannot drift out of sync with liveness.
And it was never the real guard anyway — exclusivity is enforced by the
conditional UPDATE on `orders` (§3.7), which is the only check that survives a
Redis flush.

#### What this costs

**If Redis is down, dispatch stops.** There is no Postgres fallback scan,
because there is no Postgres row to scan. This is the deliberate trade: the
fallback existed to cover a cold cache, and a store that is only ever a cache
has nothing to fall back *to*. Orders accumulate in `ready` and the sweep
assigns them when Redis returns — nothing is lost, and the restaurant and
customer both keep seeing a truthful status throughout.

The data that must survive a restart — who delivered what, and what they earned
— is in `orders` and `agent_earnings`, both of which are durable.

---

### 3.9 `agent_earnings`

One row per delivered order, written inside the settlement transaction and
denormalized so the earnings read never joins back to the partitioned `orders`.

```sql
CREATE TABLE agent_earnings (
    id              BIGSERIAL PRIMARY KEY,
    region          TEXT NOT NULL,
    agent_id        BIGINT NOT NULL,                              -- logical FK -> core.users.id
    order_id        BIGINT NOT NULL,                              -- logical FK -> orders.id (see note)
    order_public_id UUID NOT NULL,                                -- denormalized: the agent-facing order handle
    amount          INT NOT NULL CHECK (amount >= 0),             -- minor units
    currency        TEXT NOT NULL,
    earned_at       TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_agent_earnings_order_id UNIQUE (order_id)
);

-- supports GET /agents/earnings?from=&to= (list + SUM over the range)
CREATE INDEX idx_agent_earnings_agent_earned_at ON agent_earnings (agent_id, earned_at DESC);
```

Notes:
- **No FK to `orders`.** `orders` is partitioned with PK `(id, created_at)`; a child
  can only reference it by carrying `created_at`. The reference is logical and both
  rows are written in the same service transaction, exactly like `order_items`.
- **`uq_agent_earnings_order_id` is the idempotency guard** and the reason settlement
  is safe to retry. Write it through an `ON CONFLICT DO NOTHING` helper, never a
  try/catch — a constraint violation inside a transaction aborts every statement
  after it (CLAUDE.md §8).
- **`order_public_id` is denormalized on purpose.** `GET /agents/earnings` returns the
  public id for every row; without it a month of earnings is a month of cross-partition
  lookups into `orders`. It also keeps the list readable after Phase 5 archives the
  order rows out of the hot cluster.
- `amount` is stamped at settlement, not recomputed on read — a later rate change must
  not restate last month's earnings.

---

### 3.10 `idempotency_keys`

Belt-and-suspenders durability for critical write paths. Redis handles the hot path; this table is the source of truth if Redis is lost or evicts the key.

```sql
CREATE TABLE idempotency_keys (
    key_hash        BYTEA PRIMARY KEY,                            -- sha256 of (method + path + key)
    region          TEXT NOT NULL,
    user_id         BIGINT NOT NULL,
    request_fingerprint BYTEA NOT NULL,                           -- sha256 of request body
    response_status INT NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMP NOT NULL                            -- 24h TTL
);

-- supports cleanup
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
```

Used only by `POST /orders` and `POST /payments/init`. Looked up after a Redis miss; if request fingerprint doesn't match the original, return 409 (idempotency conflict).

---

### 3.11 `payment_webhook_events`

Raw webhook log for audit and replay.

```sql
CREATE TABLE payment_webhook_events (
    id              BIGSERIAL PRIMARY KEY,
    region          TEXT NOT NULL,
    provider_id     INT NOT NULL,
    provider_event_id TEXT NOT NULL,                              -- de-dup key: '<transactionId>:<status>' for Kashier
    event_type      TEXT NOT NULL,                                -- added: the provider's own event name ('pay', 'refund', ...)
    signature       TEXT NOT NULL,
    payload         JSONB NOT NULL,
    received_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMP NULL,
    process_error   TEXT NULL,

    CONSTRAINT uq_payment_webhook_events_provider_event_id UNIQUE (provider_id, provider_event_id)
);

-- supports replay/audit by order via session lookup; no additional index needed beyond the unique.
```

```sql
-- supports the operator sweep for events that arrived and never settled
CREATE INDEX idx_payment_webhook_events_received_at ON payment_webhook_events (received_at)
    WHERE processed_at IS NULL;
```

Webhook handler:
1. Verify signature (HMAC over the `signatureKeys` projection, keyed with the Payment API Key).
2. Try `INSERT ... ON CONFLICT DO NOTHING`, on its own connection, so the arrival record survives a processing failure. A conflict means "seen before" — but only a row with `processed_at` set is a true duplicate; one with `processed_at IS NULL` failed and the provider's retry is let through.
3. Otherwise, in a transaction: parse payload, advance session/ledger/order state, set `processed_at`. (No outbox event — see §0 — the WebSocket fan-out is enough for clients.)
4. On failure: roll back, stamp `process_error` on a separate connection, rethrow.

---

### 3.12 ~~`core_inbound_events`~~ — removed

Dedupe for core-event messages lives in **Redis**, not SQL. One `SET core-events:dedupe:<eventId> "1" NX EX 86400` per message.

Rationale:
- The only thing this table did for correctness was dedupe. Redis SETNX gives the same guarantee in one round-trip, no table, no migration, no per-shard insert on every broker message.
- Every registered consumer handler is an idempotent cache invalidation (`cache.del(key)`). If dedupe expires and a handler re-runs, the operation is a no-op. Safe.
- Failures still go to the DLQ — that's the observability path, not a `process_error` column.

Consumer flow (in `lib/core-events/consumer.ts`):
1. Receive message from `order-service.core-events`.
2. `cache.trySet("core-events:dedupe:<eventId>", "1", 86400)` → if not fresh, ack + skip.
3. Dispatch by `eventType` to the registered handler.
4. On success → ack. On failure → nack (no requeue) → message flows to DLQ.

---

## 4. FK / relationship map (in-shard)

```
orders ──(id)── order_items
orders ──(id)── transactions
orders ──(id)── payment_sessions
orders ──(id)── agent_earnings      (1:0..1, logical — orders is partitioned)
transactions ──(id)── transactions  (refunded_payment_id self-ref)
```

Every arrow out of `orders` is logical, not a DB-level FK: a child of a
RANGE-partitioned parent can only reference it by carrying the partition key
(`created_at`). Integrity is the service transaction's job (CLAUDE.md §7).

Logical (cross-service):

```
core.users         ← orders.customer_id
core.users         ← orders.delivery_agent_id, transactions.src_acc_id, dst_acc_id, agent_earnings.agent_id
core.restaurants   ← orders.restaurant_id, restaurant_balances.restaurant_id
core.restaurant_branches ← orders.branch_id
core.customer_addresses  ← orders.customer_address_id
core.products      ← order_items.product_id
```

---

## 5. Index summary (every index is justified)

| Table                  | Index                                              | Supports                                            |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `orders`               | `idx_orders_public_id`                             | `GET /orders/{publicId}` (+ branch-scoped copy)     |
| `orders`               | `idx_orders_customer_id_created_at`                | `GET /customer/orders?year=...`                     |
| `orders`               | `idx_orders_branch_status_created_at`              | `GET /restaurants/{rid}/branches/{bid}/orders`      |
| `orders`               | `idx_orders_status_created_at` (partial)           | Auto-assignment sweep for unclaimed `ready` orders  |
| `orders`               | `idx_orders_delivery_agent_id_status` (partial)    | `GET /agents/tasks?status=`                         |
| `order_items`          | `idx_order_items_order_id`                         | Item batch fetch                                    |
| `payment_sessions`     | `uq_payment_sessions_merchant_order_ref`           | Webhook lookup (the only handle a webhook gives)    |
| `payment_sessions`     | `idx_payment_sessions_order_id`                    | Init re-use, refund, order detail                   |
| `payment_sessions`     | `idx_payment_sessions_status_expires_at` (partial) | Expiry sweep                                        |
| `transactions`         | `idx_transactions_order_id`                        | Order ledger expansion                              |
| `transactions`         | `idx_transactions_provider_reference_id` (partial) | Refund settlement by provider reference             |
| `transactions`         | `idx_transactions_refunded_payment_id` (partial)   | Refund headroom per charge; supports the self-FK    |
| `payment_webhook_events` | `uq_payment_webhook_events_provider_event_id`    | Webhook de-dup                                      |
| `payment_webhook_events` | `idx_payment_webhook_events_received_at` (partial) | Operator sweep for unsettled events               |
| `transactions`         | `idx_transactions_dst_acc_type_created_at` (partial) | `GET /restaurant/payouts?from&to`                |
| `transactions`         | `idx_transactions_type_status_created_at`          | Admin reconciliation                                |
| `agent_earnings`       | `idx_agent_earnings_agent_earned_at`               | `GET /agents/earnings?from&to`                      |
| `idempotency_keys`     | `idx_idempotency_keys_expires_at`                  | TTL cleanup                                         |

No speculative indexes. No `CREATE INDEX` lands without a query path comment in the migration.

---

## 6. Migration plan (file order)

Each migration creates a single coherent unit. Order matters because of FK dependencies (in-shard).

1. `20260418000010_create_payment_providers.ts`        — seed `kashier` (`eg` only; see s3.3).
2. `20260418000020_create_orders.ts`                   — `orders` + indexes.
3. `20260418000030_create_order_items.ts`              — `order_items` + FK + index.
4. `20260418000040_create_payment_sessions.ts`         — `payment_sessions` + indexes.
5. `20260418000050_create_transactions.ts`             — `transactions` + indexes.
6. `20260418000060_create_restaurant_balances.ts`      — `restaurant_balances`.
7. `20260418000090_create_agent_earnings.ts`           — `agent_earnings` + unique + index.
8. `20260418000100_create_idempotency_keys.ts`         — `idempotency_keys`.
9. `20260418000110_create_payment_webhook_events.ts`   — `payment_webhook_events`.
10. `20260418000120_remove_cod_and_non_eg_providers.ts` — corrects the §3.3 seed on shards that ran it before the fix.

`20260418000070` and `20260418000080` are deliberately unused — they were
reserved for `create_deliveries` (§3.7) and `create_agent_presence` (§3.8), and
both tables were dropped from the design. Timestamps are not renumbered: shards
that already migrated must not see their ledger rewritten.

(Core-event dedupe is Redis, not a migration.)

All migrations run in **every region**. There is no global database for this service. Two of them branch on the region for *seed rows* only (s3.3) — never for schema.

The cold archive cluster (Phase 5) runs the same migration set against `order_service_archive` per region — same schema, different cluster.

---

## 7. Open questions / future work

- **Multi-currency restaurants**: when a restaurant operates in multiple regions/currencies, decide whether to keep one row per (restaurant, currency) in `restaurant_balances` or one row per region.
- **Geo-fencing for delivery radius**: today we only filter by the branch's `delivery_radius` (in core). A polygon fence is the one geo query Redis `GEO` cannot express — it does radii and boxes, not arbitrary shapes. If fencing moves here, that is the trigger to reconsider PostGIS, and it would be a *new* table rather than a restoration of `agent_presence`.
- **Presence durability**: if an operational view of agent activity over time is ever needed (shift reports, utilisation), that is an analytics concern and belongs in the analytics service (CLAUDE.md §13), not a row in the hot path.
- **Refunds policy**: partial refunds need `refund_amount` ≤ original charge — enforce with a check trigger, deferred for now.
- **Cross-region history**: with country-level shards, a customer ordering across countries is rare. If/when needed, fan out at the controller level instead of maintaining a `customer_order_index`.

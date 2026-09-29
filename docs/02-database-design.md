# Database Design — Orders & Payments Service

> Source: `databaseDesign.png` (rough draft) + explicit corrections from the team:
> *"we no longer have a payouts table, it will be included as a transaction type"*, and
> *"src_acc_id/dst_acc_id both reference a core-service user; for a restaurant we use the owner's
> user id; for the system/admin, src_acc_id is NULL when the source is the system itself."*
>
> This document is the fixed, implementation-ready schema. §1 lists every change made to the
> draft and *why*, so the reasoning is auditable. §2 onward is the actual DDL-level design.

## 0. Cross-service reference convention

This service's database has **no foreign keys into core-service's database** (separate services,
separate databases, per `system1.png`). Every column that conceptually "points at" a user,
restaurant, branch, product, or address is a **soft reference**: a plain `bigint` holding
core-service's primary key, validated at the application layer (sync call to core-service,
cached), never enforced by a DB constraint. These columns are annotated `-- soft ref: core.<table>`
throughout. Only references *within this database* (e.g. `order_items.order_id → orders.id`) are
real foreign keys.

## 1. Changes made to the draft, and why

| # | Draft | Fixed to | Why |
|---|---|---|---|
| 1 | No `payouts` table planned, but `restaurant_balances`/history implied one | `transactions.transaction_type = 'PAYOUT'` | Explicit instruction: payouts are a transaction type, not a table |
| 2 | `transactions.src_acc_id` / `dst_acc_id` — semantics undocumented | Both are **nullable soft refs to core-service users**; `NULL` means "the SYSTEM/platform itself" (as source *or* destination — the system holds funds in escrow between an `ORDER_PAYMENT` and a `PAYOUT`, so it must be representable on both sides of the ledger) | Matches the instruction for `src_acc_id = NULL`, extended symmetrically to `dst_acc_id` for internal ledger consistency (e.g. `COMMISSION` entries move money *to* the system) |
| 3 | Delivery fields (`delivery_agent_id`, `assigned_at`, `picked_at`, `delivery_at`) live directly on `orders` | Moved into a new `deliveries` table (1:1 with `orders`, PK = `order_id`) + a new append-only `delivery_assignment_attempts` table | The API contract requires **reassignment with limited retries** and a delivery-specific status machine (`accept/pickup/deliver`) that is distinct from the order's own status (`accept/reject/prep/ready`). A single `delivery_agent_id` column can't represent "agent A rejected, agent B accepted" history, which the retry logic needs. Splitting also means `deliveryId` in the API is simply the `orderId` (1:1), so no new ID space is introduced |
| 4 | No columns for rejection or cancellation, despite both being required flows | Added `orders.rejected_at`, `rejection_reason`, `cancelled_at`, `cancellation_reason`, `ready_at` | PRD requires "restaurant accepts or rejects" and admin "manual overrides"; the draft's timestamp columns only covered the happy path |
| 5 | `orders` has no payment status column; would require a join to `transactions` on every list read | Added denormalized `orders.payment_status` | Restaurant/customer order lists are read far more often than payments change status; avoids an N+1/join on the hottest read path. `transactions` remains the source of truth; `payment_status` is updated transactionally alongside it |
| 6 | Monetary columns mixed `decimal` (orders) and `bigint` (transactions) inconsistently | Standardized: **every monetary column is `bigint`, storing the smallest currency unit (minor units — cents/piastres)** | Avoids floating-point/binary-decimal rounding drift at scale; matches the draft's own `transactions.amount bigint`. Conversion to/from a provider's decimal-string format (Kashier expects `"100.00"`) happens once, at the payment-adapter boundary — see `07-kashier-integration.md` |
| 7 | `picked_at` (typo-adjacent), `delivery_at` (should read "delivered_at") | Renamed to `picked_up_at`, `delivered_at` on the new `deliveries` table | Clarity; matches naming used everywhere else (`_at` suffix = instant, full word not abbreviation) |
| 8 | No idempotency storage modeled | Added `idempotency_keys` table | core-service has `lib/Idempotency`, but it is backed by core-service's own Postgres — this service has its **own** database, so it needs its own idempotency store even though it reuses the same library code shape |
| 9 | No shard/region column anywhere | Added `region` to every table that needs to be partitioned/sharded (`orders`, `order_items` via parent, `transactions`, `deliveries`, `delivery_assignment_attempts`, `agent_earnings`, `agent_presence`, `restaurant_balances`) | Required for the region-sharding strategy in `01-system-design.md` §7 |
| 10 | Implicit per-shard auto-increment `id` (bigint) for every table | `orders` and `transactions` (the two tables an external actor — a webhook, an admin, a support agent — might need to reference **before** we know which shard they live in) get **application-generated, globally-unique, time-sortable IDs** (Snowflake-style: `[41-bit ms timestamp][8-bit region id][14-bit sequence]`). Purely internal child rows (`order_items`, `delivery_assignment_attempts`, `agent_earnings`) keep ordinary per-shard `bigserial`, since they're only ever looked up via their parent, which is already shard-resolved | Prevents ID collisions across regional shards for the two aggregate roots that need global identity, without a centralized ID-allocation service, and keeps IDs roughly ordered by creation time (good index locality for the "high write orders" workload) |
| 11 | `payment_providers` — unclear if per-shard or shared | Documented as a **small, rarely-written, globally-replicated reference table**: identical rows seeded into every regional shard via migration; never written by application code at runtime | A payment-init call must never take a cross-region hop just to read "is Kashier enabled"; replication of a handful of rows is cheap and avoids that hop |
| 12 | `agent_presence` had only lat/lng/last_seen, no explicit online/offline state | Added `status` (`ONLINE`/`OFFLINE`) | `POST /agents/presence/online` / `/offline` need somewhere durable to record state changes; live location stays in Redis (see §6) |
| 13 | `restaurant_balances` had no concurrency control | Added `version bigint` (optimistic lock) | Balance is mutated by concurrent events (order delivered, payout recorded, refund issued); optimistic locking prevents lost updates without serializing all writes for a restaurant |

## 2. Enums

Native Postgres enum types (matches the draft's own "enum" column annotations). New values are
additive-only migrations (`ALTER TYPE ... ADD VALUE`, run in its own migration, never combined
with a migration that uses the new value, per Postgres's transactional-DDL limitation on enums).

```
order_status        := PENDING_PAYMENT | PAYMENT_FAILED | PLACED | ACCEPTED | REJECTED
                      | PREPARING | READY_FOR_PICKUP | OUT_FOR_DELIVERY | DELIVERED | CANCELLED

order_payment_method := ONLINE | COD

order_payment_status := PENDING | AUTHORIZED | PAID | FAILED
                      | REFUNDED | PARTIALLY_REFUNDED | COD_PENDING | COD_COLLECTED

transaction_type     := ORDER_PAYMENT | REFUND | COMMISSION | PAYOUT | ADJUSTMENT

transaction_method   := ONLINE | COD | BANK_TRANSFER | INTERNAL
                        -- INTERNAL = no external money movement (COMMISSION, ADJUSTMENT)

transaction_status   := PENDING | PROCESSING | SUCCESS | FAILED | REVERSED

delivery_status      := UNASSIGNED | ASSIGNED | PICKED_UP | DELIVERED | FAILED

assignment_outcome   := ACCEPTED | REJECTED | TIMED_OUT | CANCELLED

agent_status         := ONLINE | OFFLINE
```

### Order status × delivery status relationship

`orders.status` is owned by the restaurant-facing lifecycle (`PATCH /orders/{orderId}/status`).
`deliveries.status` is owned by the agent-facing lifecycle (`PATCH /deliveries/{deliveryId}/status`).
They are kept in sync by the service layer, in the same DB transaction, at two junctures:

- `deliveries.status → ASSIGNED` (first assignment succeeds) sets `orders.status → OUT_FOR_DELIVERY`
  (only if the order was `READY_FOR_PICKUP`).
- `deliveries.status → DELIVERED` sets `orders.status → DELIVERED`.

No other cross-writes happen; this keeps each table the single writer of its own status column
from the perspective of its own module (`orders` module owns `orders.status`, `delivery` module
owns `deliveries.status`), with one explicit, documented exception in each direction.

## 3. Tables

All tables below live in **every regional shard** unless marked "global". `region` is the shard
key; it is denormalized onto every row for partition routing and is never updated after insert.

### 3.1 `orders`

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` PK | Snowflake ID (see §1.10) |
| `region` | `text` NOT NULL | shard key |
| `country_code` | `char(2)` NOT NULL | ISO 3166-1 alpha-2 |
| `restaurant_id` | `bigint` NOT NULL | soft ref: `core.restaurants` |
| `branch_id` | `bigint` NOT NULL | soft ref: `core.branches` |
| `customer_id` | `bigint` NOT NULL | soft ref: `core.users` |
| `customer_address_id` | `bigint` NOT NULL | soft ref: `core.addresses` |
| `delivery_lat` | `numeric(9,6)` NOT NULL | |
| `delivery_lng` | `numeric(9,6)` NOT NULL | |
| `delivery_address_text_snapshot` | `text` NOT NULL | frozen at order time; address can change later in core-service |
| `status` | `order_status` NOT NULL DEFAULT `'PENDING_PAYMENT'` | |
| `payment_method` | `order_payment_method` NOT NULL | |
| `payment_status` | `order_payment_status` NOT NULL DEFAULT `'PENDING'` | denormalized from `transactions`, see §1.5 |
| `subtotal_minor` | `bigint` NOT NULL CHECK (`>= 0`) | sum of `order_items.line_total_minor` at creation |
| `delivery_fee_minor` | `bigint` NOT NULL DEFAULT 0 | |
| `service_fee_minor` | `bigint` NOT NULL DEFAULT 0 | |
| `total_minor` | `bigint` GENERATED ALWAYS AS (`subtotal_minor + delivery_fee_minor + service_fee_minor`) STORED | |
| `currency` | `char(3)` NOT NULL | ISO 4217 |
| `accepted_at` | `timestamptz` NULL | |
| `rejected_at` | `timestamptz` NULL | |
| `rejection_reason` | `text` NULL | |
| `ready_at` | `timestamptz` NULL | restaurant marked order ready for pickup |
| `cancelled_at` | `timestamptz` NULL | |
| `cancellation_reason` | `text` NULL | |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

Partitioned by `RANGE (created_at)`, one partition per year, per §7.4 of the system design doc.

**Indexes**
```
PRIMARY KEY (id)
idx_orders_restaurant_status_created   ON (restaurant_id, status, created_at DESC)
  -- GET /restaurant/orders?branchId=&status=&from=&to=
idx_orders_branch_status_created       ON (branch_id, status, created_at DESC)
idx_orders_customer_created            ON (customer_id, created_at DESC)
  -- GET /customer/orders?year=YYYY
idx_orders_status_payment_status       ON (status, payment_status)
  -- reconciliation / stuck-order jobs
```

### 3.2 `order_items`

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` PK, `bigserial` | shard-local id (always accessed via `order_id`) |
| `order_id` | `bigint` NOT NULL REFERENCES `orders(id)` ON DELETE CASCADE | real FK — same shard |
| `product_id` | `bigint` NOT NULL | soft ref: `core.products` |
| `name_snapshot` | `text` NOT NULL | |
| `image_url_snapshot` | `text` NULL | |
| `unit_price_minor_snapshot` | `bigint` NOT NULL CHECK (`>= 0`) | |
| `quantity` | `integer` NOT NULL CHECK (`quantity > 0`) | |
| `line_total_minor` | `bigint` GENERATED ALWAYS AS (`unit_price_minor_snapshot * quantity`) STORED | |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

**Indexes**
```
PRIMARY KEY (id)
idx_order_items_order   ON (order_id)
```

### 3.3 `transactions` (the ledger — absorbs payments, refunds, commission, *and* payouts)

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` PK | Snowflake ID |
| `region` | `text` NOT NULL | shard key |
| `order_id` | `bigint` NULL REFERENCES `orders(id)` | NULL for `PAYOUT`/`ADJUSTMENT` rows not tied to one order |
| `transaction_type` | `transaction_type` NOT NULL | `ORDER_PAYMENT \| REFUND \| COMMISSION \| PAYOUT \| ADJUSTMENT` |
| `method` | `transaction_method` NOT NULL | |
| `provider_id` | `bigint` NULL REFERENCES `payment_providers(id)` | NULL for `COD`/`INTERNAL` |
| `provider_reference_id` | `text` NULL | Kashier `transactionId` / transfer id |
| `idempotency_key` | `text` NULL | client-supplied key that produced this row |
| `status` | `transaction_status` NOT NULL DEFAULT `'PENDING'` | |
| `provider_status_raw` | `text` NULL | passthrough of the provider's own status string, for audit/debug without needing a new enum value per provider quirk |
| `amount_minor` | `bigint` NOT NULL CHECK (`amount_minor > 0`) | always positive; direction is expressed by `src_acc_id`/`dst_acc_id`, not sign |
| `currency` | `char(3)` NOT NULL | |
| `src_acc_id` | `bigint` NULL | soft ref: `core.users`; `NULL` = SYSTEM (see §1.2) |
| `dst_acc_id` | `bigint` NULL | soft ref: `core.users`; `NULL` = SYSTEM (see §1.2) |
| `is_refunded` | `boolean` NOT NULL DEFAULT `false` | only meaningful on `ORDER_PAYMENT` rows |
| `refunded_txn_id` | `bigint` NULL REFERENCES `transactions(id)` | on a `REFUND` row, points back at the `ORDER_PAYMENT` row it reverses |
| `metadata` | `jsonb` NULL | raw webhook/provider payload, for audit |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

**Constraints**
```
CHECK (src_acc_id IS NOT NULL OR dst_acc_id IS NOT NULL)
  -- a transaction can't be SYSTEM-to-SYSTEM (meaningless)
CHECK (transaction_type <> 'ORDER_PAYMENT' OR order_id IS NOT NULL)
CHECK (transaction_type <> 'REFUND'        OR refunded_txn_id IS NOT NULL)
```

**Indexes**
```
PRIMARY KEY (id)
idx_txn_order                    ON (order_id) WHERE order_id IS NOT NULL
idx_txn_provider_ref UNIQUE      ON (provider_id, provider_reference_id) WHERE provider_reference_id IS NOT NULL
  -- prevents double-processing the same webhook/callback
idx_txn_idempotency  UNIQUE      ON (idempotency_key) WHERE idempotency_key IS NOT NULL
idx_txn_dst_type_created          ON (dst_acc_id, transaction_type, created_at DESC)
  -- GET /restaurant/payouts?from=&to=  (dst_acc_id = restaurant owner id, type = PAYOUT)
idx_txn_status_pending            ON (status) WHERE status IN ('PENDING','PROCESSING')
  -- reconciliation job scans only in-flight rows
```

### 3.4 `payment_providers` — **global reference table** (replicated to every shard, migration-seeded only)

| Column | Type | Notes |
|---|---|---|
| `id` | `smallint` PK | |
| `code` | `text` UNIQUE NOT NULL | e.g. `KASHIER`, `COD` |
| `name` | `text` NOT NULL | |
| `is_enabled` | `boolean` NOT NULL DEFAULT `true` | |
| `priority` | `smallint` NOT NULL DEFAULT `0` | selection order when multiple online providers exist |
| `config` | `jsonb` NULL | non-secret routing config only; credentials live in env/secret manager, never in this table |
| `created_at` / `updated_at` | `timestamptz` | |

### 3.5 `deliveries` — 1:1 with `orders` (new table, see §1.3)

| Column | Type | Notes |
|---|---|---|
| `order_id` | `bigint` PK REFERENCES `orders(id)` ON DELETE CASCADE | **this is the `deliveryId` used throughout the API** |
| `region` | `text` NOT NULL | |
| `status` | `delivery_status` NOT NULL DEFAULT `'UNASSIGNED'` | |
| `current_agent_id` | `bigint` NULL | soft ref: `core.users` |
| `attempt_count` | `smallint` NOT NULL DEFAULT `0` | incremented per offer; capped by a configured max-retries constant |
| `assigned_at` | `timestamptz` NULL | |
| `picked_up_at` | `timestamptz` NULL | |
| `delivered_at` | `timestamptz` NULL | |
| `failed_at` | `timestamptz` NULL | all retries exhausted |
| `created_at` / `updated_at` | `timestamptz` | |

**Indexes**
```
PRIMARY KEY (order_id)
idx_deliveries_agent_status   ON (current_agent_id, status) WHERE current_agent_id IS NOT NULL
  -- GET /agents/tasks?status=
```

### 3.6 `delivery_assignment_attempts` — append-only offer history (new table, see §1.3)

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` PK, `bigserial` | |
| `order_id` | `bigint` NOT NULL REFERENCES `deliveries(order_id)` | |
| `agent_id` | `bigint` NOT NULL | soft ref: `core.users` |
| `offered_at` | `timestamptz` NOT NULL DEFAULT `now()` | |
| `responded_at` | `timestamptz` NULL | |
| `outcome` | `assignment_outcome` NULL | NULL while still outstanding |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

**Indexes**
```
PRIMARY KEY (id)
idx_attempts_order_offered   ON (order_id, offered_at DESC)
```

### 3.7 `agent_earnings`

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` PK, `bigserial` | |
| `region` | `text` NOT NULL | |
| `agent_id` | `bigint` NOT NULL | soft ref: `core.users` |
| `order_id` | `bigint` NOT NULL REFERENCES `orders(id)` | |
| `amount_minor` | `bigint` NOT NULL CHECK (`>= 0`) | |
| `currency` | `char(3)` NOT NULL | |
| `earned_at` | `timestamptz` NOT NULL | = `deliveries.delivered_at` |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

**Indexes**
```
PRIMARY KEY (id)
idx_earnings_order UNIQUE      ON (order_id)
  -- one earning row per delivered order, guards against double-crediting
idx_earnings_agent_earned      ON (agent_id, earned_at DESC)
  -- GET /agents/earnings?from=&to=
```

### 3.8 `restaurant_balances`

| Column | Type | Notes |
|---|---|---|
| `restaurant_id` | `bigint` PK | soft ref: `core.restaurants` |
| `region` | `text` NOT NULL | |
| `balance_minor` | `bigint` NOT NULL DEFAULT `0` | always equal to the sum of relevant ledger entries — see invariant below |
| `currency` | `char(3)` NOT NULL | |
| `version` | `bigint` NOT NULL DEFAULT `0` | optimistic concurrency token |
| `updated_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

> **Invariant:** `balance_minor` is only ever changed by a repository method that, in the same DB
> transaction, also inserts the `transactions` row that justifies the change, and bumps `version`.
> No code path updates this table directly. See `04-modules/restaurant-finance.md`.

### 3.9 `agent_presence` — durability snapshot (hot path is Redis, see §6)

| Column | Type | Notes |
|---|---|---|
| `agent_id` | `bigint` PK | soft ref: `core.users` |
| `region` | `text` NOT NULL | |
| `status` | `agent_status` NOT NULL DEFAULT `'OFFLINE'` | |
| `last_lat` | `numeric(9,6)` NULL | |
| `last_lng` | `numeric(9,6)` NULL | |
| `last_seen_at` | `timestamptz` NULL | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

Written on `online`/`offline` transitions synchronously; written on `ping` **asynchronously and
throttled** (e.g. at most once per N seconds per agent) — every `ping` still updates Redis
synchronously. See §6.

### 3.10 `idempotency_keys` (new table, see §1.8)

| Column | Type | Notes |
|---|---|---|
| `key` | `text` PK | composite of route + client-supplied `Idempotency-Key` + actor id, hashed |
| `region` | `text` NOT NULL | |
| `request_hash` | `text` NOT NULL | hash of the request body; a key reused with a different body is a `409` |
| `status` | `text` NOT NULL DEFAULT `'IN_PROGRESS'` | `IN_PROGRESS \| COMPLETED` |
| `response_status` | `smallint` NULL | |
| `response_body` | `jsonb` NULL | |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | |
| `expires_at` | `timestamptz` NOT NULL | |

**Indexes**
```
PRIMARY KEY (key)
idx_idempotency_expires   ON (expires_at)
  -- for the TTL cleanup job
```

## 4. Global ID generation (Snowflake-style)

`orders.id` and `transactions.id` are generated in application code (not by the database), as a
64-bit integer:

```
 63           23 22        15 14             0
[ timestamp_ms ][ region_id ][   sequence    ]
      41 bits        8 bits        14 bits
```

- `timestamp_ms`: milliseconds since a fixed epoch (e.g. 2026-01-01).
- `region_id`: this region's assigned 8-bit id (from a small static config, one per shard).
- `sequence`: monotonic counter reset each millisecond, wraps at 16384, guarded by an
  in-process lock per region worker.

This lives in `pkg/id` (no app/env awareness — pure function of `(now, region_id, sequence)`), so
it is trivially unit-testable and reusable from any module. See `05-folder-structure.md`.

## 5. Sharding & partitioning summary

- **Shard key:** `region` — one Postgres **database per country** (see `01-system-design.md` §7.1;
  "region" and "country" are the same thing in this codebase at v1). Each shard is a **single
  primary instance, no read replicas** at this stage.
- **Partition key (within a shard):** `created_at`, `RANGE` partitioned yearly, on `orders`,
  `order_items` (partitioned the same way and pruned together with its parent — see note below),
  and `transactions`.
- `order_items` doesn't have its own `created_at`-range partitioning trigger; instead, partition
  it **the same year as its parent order** (the migration creates matching yearly partitions for
  both tables together, and application code always writes both in the same transaction, so they
  move to archive storage in lockstep).
- `payment_providers` is global/replicated (§3.4), not partitioned.
- Archival: a yearly background-worker job detaches the completed year's partitions and copies them
  into a **cold Postgres database, one per country** (mirroring the hot shard split), then drops
  the detached partition from the hot shard — see `01-system-design.md` §7.4/§11.

## 6. Redis-resident data (not in Postgres, or only durability-snapshotted there)

| Key pattern | Purpose | TTL |
|---|---|---|
| `orders:idem:{key}` | fast idempotency check ahead of the `idempotency_keys` table hit | matches table `expires_at` |
| `agents:geo:{region}` (Redis geo set) | live agent lat/lng for nearest-agent queries (`GEOSEARCH`) | member refreshed each `ping`, expired via a companion TTL key if agent goes silent |
| `agents:lastseen:{agentId}` | last ping timestamp | short TTL, refreshed each ping |
| `cache:core:restaurant:{id}` / `cache:core:branch:{id}` / `cache:core:address:{id}` / `cache:core:product:{id}` | read-through cache of core-service lookups (product entry includes price/stock/isAvailable) | short TTL (seconds-minutes), never authoritative — plus event-driven deletion, see below |
| `dedupe:event:{eventId}` | marks a consumed RabbitMQ event as already handled, so a redelivery is not applied twice (`lib/cache/invalidation-subscriber.ts`) | 10 minutes |

**Redis is used for caching and ephemeral state only — never as a message bus.** The two
Pub/Sub channels this table used to list (`orders:status:{orderId}` for WebSocket fan-out and
`core:invalidate:{entityType}` for cache invalidation) are gone: Redis Pub/Sub was removed
entirely and all eventing moved to RabbitMQ.

- Cache invalidation now arrives on the `core.events` topic exchange with routing key
  `core.<entityType>.invalidated` (`01-system-design.md` §5.1). Because RabbitMQ redelivers
  unacked messages, the consumer dedupes on `eventId` via the `dedupe:event:*` key above.
- Real-time status fan-out across instances is **currently unimplemented** — see
  `01-system-design.md` §5.2.

All keys are prefixed `orders:` or `agents:`/`cache:core:`/`dedupe:` to coexist safely in the
Redis instance shared with core-service (see `01-system-design.md` §5 and `AGENTS.md`).

## 7. Open design questions to validate with the team

1. ~~**Archive storage destination**~~ — **Resolved:** a cold Postgres database, one per
   country/region, mirroring the hot shard split — see `01-system-design.md` §7.4/§11. Kept as
   item 1 (not deleted) so §7.2/§7.3 below keep their existing numbers, since both are referenced
   elsewhere by number (`04-modules/delivery-agent.md` §7.3).
2. **Cross-region customer order history** — given the (expected) small number of regions, the
   default plan is a parallel fan-out-and-merge across all regional shards rather than a bespoke
   directory table (see `01-system-design.md` §7.3); revisit if region count grows large enough
   that fan-out latency becomes a problem.
3. **`agent_presence` flush cadence** — needs a concrete throttle value (e.g. 30s) once we have
   real ping-volume numbers.

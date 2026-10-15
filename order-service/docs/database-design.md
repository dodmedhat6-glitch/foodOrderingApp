# Database design

One Postgres database per country (the *hot shard*) and an identical *archive
shard* holding prior years. The same migrations (`src/migrations/`) run on both.

General rules:
- Money is `INT` minor units.
- Every table has a `region` column.
- References to core-service data (users, restaurants, branches, products,
  addresses) are plain ids with no foreign key, because that data lives in
  another database.
- Nothing has a foreign key into `orders`: it is partitioned, and Postgres would
  need the partition key in the reference. The code writes parent and children
  in one transaction instead.

## Tables

### `orders` (partitioned by month on `created_at`)

| Column(s) | Notes |
| --- | --- |
| `id`, `created_at` | Primary key together. |
| `public_id` | UUIDv7; the id clients see. Its timestamp lets lookups go straight to the right partition. |
| `restaurant_id`, `branch_id`, `customer_id`, `customer_address_id` | Core ids. |
| `delivery_lat/lng`, `delivery_address_text_snapshot`, `branch_name_snapshot`, `restaurant_name_snapshot` | Copied at placement, so the order reads the same later. |
| `status`, `status_reason` | See [orders.md](business-logic/orders.md). |
| `subtotal`, `delivery_fee`, `service_fee`, `total`, `commission`, `currency` | `total = subtotal + delivery_fee + service_fee`; `commission ≤ subtotal`. |
| `payment_method` | `online` or `cod`. |
| `delivery_agent_id` | Set when an agent claims the order. |
| `placed_at` … `cancelled_at` | One timestamp per status. |

Partitions `orders_YYYYMM` are created ahead of time by a worker job, and
`orders_default` catches anything that falls outside them.

### Children of an order

| Table | Key columns | Purpose |
| --- | --- | --- |
| `order_items` | `order_id`, `product_id`, `quantity`, `unit_price_snapshot`, `line_total` | Lines, priced at placement. |
| `payment_sessions` | `order_id`, `merchant_order_ref` (unique), `provider_order_id`, `status`, `expires_at` | One per Kashier checkout attempt. |
| `agent_earnings` | `order_id` (unique), `agent_id`, `amount`, `distance_meters`, `earned_at` | What the agent earned for a delivery. Unique per order, so it is never paid twice. |

### `transactions`: the money ledger

One row per money movement. `transaction_type` is one of `charge`, `refund`,
`commission`, `cod_collection`, `payout`, `adjustment`. `amount` is always
positive; `src_acc_id` / `dst_acc_id` say which way it moved (NULL = the
platform). `restaurant_id` says whose money it is. `idempotency_key` is unique;
that constraint is what stops a replayed webhook or settlement from writing a
row twice. `refunded_payment_id` points a refund at its charge.

### Others

| Table | Purpose |
| --- | --- |
| `restaurant_balances` | Primary key `(restaurant_id, currency)`. The platform's running debt to the restaurant. Goes up at delivery, down at payout. Can go negative. |
| `payment_providers` | Lookup table (`kashier`). |
| `payment_webhook_events` | Every webhook received, unique on `(provider_id, provider_event_id)`, stamped `processed_at` or `process_error`. |
| `idempotency_keys` | Backup copy of idempotency records (Redis is the first stop). Expired rows are purged hourly. |

There is no `deliveries` table (a delivery is the later part of an order) and
no presence table (presence lives only in Redis).

## Indexes

Each index exists for a specific query:

| Index | Serves |
| --- | --- |
| `orders (public_id)` | Lookup by public id |
| `orders (customer_id, created_at DESC)` | Customer order history |
| `orders (branch_id, status, created_at DESC)` | Restaurant dashboard |
| `orders (status, created_at)` partial: `preparing/ready/assigned` | Dispatch sweep |
| `orders (delivery_agent_id, status)` partial | Agent's active order and task list |
| `order_items (order_id)`, `payment_sessions (order_id)`, `transactions (order_id)` | Loading an order's children |
| `payment_sessions (status, expires_at)` partial | Payment expiry sweep |
| `transactions (provider_reference_id)` | Matching refund webhooks |
| `transactions (restaurant_id, transaction_type, created_at DESC)` | Payout history, finance summary |
| `transactions (transaction_type, status, created_at DESC)` | Reconciliation |
| `agent_earnings (agent_id, earned_at DESC)` | Agent earnings |
| `payment_webhook_events (received_at)` partial: unprocessed | Finding stuck webhooks |
| `idempotency_keys (expires_at)` | Purge job |

## Migrations

`npm run migrate:all` migrates every region's hot shard;
`npx tsx scripts/migrate-all.ts --cluster=archive` migrates the archive
shards. Migrations are never edited after they ship: a fix is a new migration.

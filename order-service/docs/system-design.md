# System design

## Two processes, one codebase

| Process | Entry | Does |
| --- | --- | --- |
| API | `src/server.ts` | HTTP (`/api`), WebSocket (`/ws`), consumes core's events from RabbitMQ |
| Worker | `src/worker.ts` | Runs background jobs. Serves no HTTP. |

The API scales horizontally. Run one worker per region, or more: every job is
safe to run twice, and archival takes a Redis lock.

Worker jobs:

| Job | Every | Does |
| --- | --- | --- |
| `order:partition-maintenance` | 24h | Creates the next 3 monthly `orders` partitions |
| `payment:expiry-sweep` | 60s | Cancels unpaid online orders past their session expiry and gives the stock back |
| `delivery:assignment-sweep` | 15s | Offers unclaimed orders to nearby agents |
| `agent:presence-sweep` | 60s | Removes stale agents from the geo index |
| `archival:nightly` | 1h (works 02:00–05:00 only) | Moves prior-year data to the archive DB |
| `idempotency:purge-expired` | 1h | Deletes expired idempotency records |

## Data

**Postgres, sharded by country.** Every country (`eg`, `sa`, …) has its own
database, the *hot shard*, plus an *archive shard* for prior years. The code
calls the shard key `region`. Every request names its region with the
`X-Region` header (the only source; missing → 400). Nothing queries across
shards.

- `db(region)` → hot shard, `dbArchive(region)` → archive shard (`lib/knex/knex.ts`).
- `orders` is partitioned by month on `created_at`.
- Money is always an integer in minor units (piasters, halalas).

**Redis** (this service's own instance):

- Cached copies of core data: branches (60s), products (30s), role permissions (5m).
- Response cache for the restaurant order list (10s).
- Idempotency records (24h; also stored in Postgres for order and payment writes).
- Agent presence: a GEO index per region plus a per-agent key that expires
  after 5 minutes without a ping.
- socket.io adapter, so an event published by any process reaches every socket.
- Locks (archival) and de-duplication of core events.

## Talking to core-service

**Sync (HTTP)**: `lib/core-client/`, authenticated with an `x-api-key` header.

| Call | Used for |
| --- | --- |
| `GET /api/internal/branches/:id` | Branch info, fees, commission, trading flags, location |
| `GET /api/internal/products?branchId=&ids=` | Price, stock, availability |
| `POST /api/internal/branches/:id/reserve-stock` / `release-stock` | Hold stock at placement, give it back on failure or cancellation |
| `GET /api/internal/addresses/:id` | Delivery address snapshot |
| `GET /api/internal/users/:id` | Agent name for tracking |
| `GET /api/roles/:role/permissions` | Permission check for restaurant users |

**Async (RabbitMQ, inbound only)**: core publishes `core.<entity>.invalidated`
events through its outbox to the `core.events` exchange. This service consumes
them (queue `order-service.core-events`, binding `core.#`, plus a dead-letter
queue) and **patches** its cached copy when the event carries the new values,
or deletes it when it doesn't. Delivery is at-least-once; duplicates are
dropped by event id. This service publishes no events of its own.

## Real-time (socket.io)

Clients connect to `/ws` with their access token and subscribe to the rooms
they're allowed: `customer:<id>`, `restaurant:<id>`, `branch:<id>`,
`agent:<id>`, and `admin` (system admins). Services publish right after a
change commits. Event list: [api-contracts.md](api-contracts.md#websocket).

## Payments

Kashier v3 hosted checkout, behind the `IPaymentProvider` interface
(`pkg/payments/`). Cash on delivery needs no provider. See
[business-logic/payments.md](business-logic/payments.md).

## Archival

Each night, finished orders from previous years move to the archive shard,
together with everything attached to them. Reads that ask for a previous year
read both shards. See [business-logic/archival.md](business-logic/archival.md).

## Outbound events

When an order becomes `placed` (COD at placement, online at payment capture), the
same transaction writes an `order.placed` row to the shard's `events_outbox`. The
worker drains every shard's outbox onto the `order.events` exchange every 2 s
(`FOR UPDATE SKIP LOCKED`, publisher confirms). analytics-service consumes it.
Details: `lib/events/` and CLAUDE.md §8 "Outbound events".

## Out of scope

The analytics service itself (`analytics-service/`), read replicas, promo codes, and loyalty.
Deployment and load testing are a separate effort.

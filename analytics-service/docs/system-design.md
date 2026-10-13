# System design

## 1. Where analytics-service sits

```
                           ┌──────────────────────────────┐
     browser / app ───────►│ core-service  (Node, PG, Redis)│  users, restaurants, products, RBAC catalog
         │   JWT (HS256,   └──────┬───────────────▲───────┘
         │   ACCESS_SECRET)       │ outbox        │ GET /api/roles/{role}/permissions
         │                        ▼ core.events   │ (x-api-key)                    
         │                 ┌──────────────┐       │
         │                 │   RabbitMQ   │       │
         │                 └──┬────────▲──┘       │
         │       core.#       │        │ order.events (topic)
         │   ┌────────────────┘        │                     │
         │   ▼                         │ outbox drain        │
         │ ┌─────────────────────────────────┐               │
         ├►│ order-service (Node, sharded PG)│               │
         │ │  API ── placeOrder trx ─┐       │               │
         │ │  worker ◄── events_outbox (per shard)           │
         │ └─────────────────────────────────┘               │
         │                         │ order.#, payment.#      │
         │                         ▼                         │
         │ ┌─────────────────────────────────────────────────┴─┐
         └►│ analytics-service (Python, FastAPI)                 │
           │  EventConsumer ─► AnalyticsService ─► MongoDB       │
           │  GET /api/v1/analytics/... ─► AnalyticsService      │
           └─────────────────────────────────────────────────────┘
                              │
                              ▼
                     MongoDB  quickbite_analytics
                       agg_restaurant_day   event_ids
```

Analytics is a **pure downstream**: it reads core synchronously only for authorization, reads order activity only asynchronously, and nobody reads from it except humans over HTTP.

## 2. Flows

### 2.1 Async — an order becomes a number (write path)

```
order-service                             RabbitMQ                     analytics-service
─────────────                             ────────                     ─────────────────
POST /api/orders (COD)
  BEGIN (shard eg)
    INSERT orders, order_items
    INSERT events_outbox(order.placed)    ◄─ same trx: event iff order
  COMMIT
worker tick (2s), per region:
  BEGIN
    SELECT … FOR UPDATE SKIP LOCKED
    publish (confirm) ──────────────────► order.events ──order.#──► analytics-service.order-events
    UPDATE status='published'                                               │
  COMMIT                                                                    ▼
                                                              EventConsumer.handle
                                                                parse Envelope ── bad ──► DLQ
                                                                routing key == eventType? ── no ──► DLQ
                                                                handler for type? ── no ──► ack
                                                                event_ids.insert_one ── dup ──► ack
                                                                handler → AnalyticsService.on_order_placed
                                                                  agg_restaurant_day.update_one(
                                                                    {restaurant_id, date},
                                                                    {$inc, $setOnInsert, $set}, upsert)
                                                                ack
```

Online orders take the same path, but their `order.placed` is enqueued in the **payment webhook's** transaction, when the capture moves them from `pending_payment` to `placed`. An order nobody paid for never becomes an event.

### 2.2 Sync — a number becomes a response (read path)

```
GET /api/v1/analytics/restaurants/42/days?from=…&to=…
  CorrelationMiddleware      X-CorrelationId in/out, ContextVar
  AccessLogMiddleware        one line on the way out
  ErrorBoundary              any unhandled exception → 500 envelope
  FastAPI dependencies:
    Authenticate             cookie | Bearer → verify HS256 → Claims       (401)
    require_restaurant_member path restaurantId == claims.restaurantId     (403 / 400 if malformed)
    require("analytics:read") PermissionsCache.get(restaurantRole)          (403)
                               └─ miss → CoreRbacClient → core GET /api/roles/{role}/permissions
    RestaurantDaysQuery      ?from&to as YYYY-MM-DD                        (400 VALIDATION_ERROR)
  AnalyticsController → AnalyticsService.get_restaurant_days
                           from ≤ to, span ≤ 366                           (400 ANALYTICS_…)
                           repo.find_range → uq_(restaurant_id,date) index
                           project: avgOrderMinor = round_half_up(revenue/orders)
  → RestaurantDayResponse[] → send_success
```

## 3. Data model

`agg_restaurant_day` — one document per restaurant per UTC day:

```json
{ "restaurant_id": 42, "date": "2026-10-13", "currency": "EGP",
  "orders_count": 2, "revenue_sum": 4000,
  "delivery_ms_sum": 0, "delivery_ms_count": 0,
  "updated_at": ISODate("2026-10-13T18:50:01.944Z") }
```

- Unique `(restaurant_id, date)`; range index `(date, restaurant_id)`.
- **Sums and counts only.** `avgOrderMinor` is computed on read. Two partial documents for the same day (live + backfill) merge by addition; averages would not.
- `date` is the UTC day of the event's `placedAt` — the business time, not the processing time. A message delayed by an outage still lands on the right day.

`event_ids` — `{event_id, received_at}`, unique `event_id`, TTL 7 days on `received_at`.

## 4. Failure modes

| What fails | What happens | Data outcome | Recovery |
| --- | --- | --- | --- |
| RabbitMQ down when order placed | Outbox row stays `pending`; drain publish times out (5 s), row `attempts++`, batch aborted | Delayed, not lost | Automatic on next tick once broker returns |
| RabbitMQ down for > 5 drain attempts | Row marked `failed` | Parked | Operator sets `status='pending'` |
| Drain crashes after publish, before commit | Row republished next tick | Duplicate delivery | Consumer dedupe (`event_ids`) |
| RabbitMQ down at analytics boot | Warns, retries with backoff in background; HTTP serves | Events queue up in RabbitMQ | Automatic |
| RabbitMQ drops while running | aio-pika robust connection reconnects and restores queue, bindings, consumer | Unacked messages redelivered | Automatic; dedupe absorbs redeliveries |
| MongoDB down at boot | Boot fails (`ServerSelectionTimeoutError` after 5 s) | — | Start Mongo; restart |
| MongoDB down while running | `mark_seen` raises → message dead-lettered; reads → 500 | Events in DLQ | Replay DLQ when Mongo is back (ids were never recorded, so they apply) |
| Malformed envelope / wrong payload | DLQ (`ANALYTICS_INVALID_EVENT_PAYLOAD` logged with pydantic errors) | Not applied | Fix publisher, replay DLQ |
| Routing key ≠ envelope `eventType` | DLQ | Not applied | Fix publisher |
| Unknown event type (`payment.*` today) | Logged, acked | Ignored | Add a handler; backfill if history matters |
| Handler raises mid-way | `forget(eventId)`, DLQ | Not applied (single `update_one` is atomic) | Replay DLQ — it applies |
| Process killed between `mark_seen` and the upsert | Message redelivered, but id is already recorded → skipped | **One event lost** | Backfill. Closing this needs a replica set + transaction around both writes (see §5) |
| Two consumers, same new day | Unique index; server retries the losing upsert as an update | Correct | — |
| core-service down | Cached roles keep working until TTL; uncached → 503 `CORE_UNAVAILABLE` | — | Automatic |
| Permissions changed in core | Up to `RBAC_CACHE_TTL_SEC` (5 min) stale | — | Homework: `rbac.permissions_changed` → `invalidate(role)` |
| Out-of-order events (`delivered` before `placed`) | Each upsert creates the day if absent | Correct once both arrive | — (design requirement for homework handlers) |

## 5. Why dedupe in Mongo, not Redis `SETNX`

order-service dedupes core's events with Redis `SETNX core-events:dedupe:<id>` (24 h TTL). That works *there* because every core-event handler is **idempotent** — patching a cache with the same values twice, or deleting a key twice, changes nothing. The dedupe is an optimization.

Here the handlers are **not idempotent**: `$inc: {orders_count: 1}` applied twice counts the order twice. The dedupe record is now part of correctness, which changes the requirements:

1. **Durability matches the data.** If the dedupe store loses state (Redis restarted without persistence, evicted under `maxmemory`) while the aggregate keeps it, every redelivery double-counts. Keeping the ledger in the same Mongo as the aggregates means they are backed up, restored and lost together.
2. **One less dependency.** This service needs Mongo anyway; Redis would be a second stateful system solely for this.
3. **The unique index is the atomic test-and-set.** `insert_one` + `DuplicateKeyError` is exactly `SETNX`, and the TTL index is exactly `EX`.
4. **It points at the real fix.** On a replica set, the `event_ids` insert and the aggregate `update_one` can share one transaction — then a crash between them can't lose an event (§4's one remaining hole). With Redis that can never be atomic with the aggregate write.

The price: one extra write per event, and a 7-day TTL instead of 24 h (Mongo's TTL monitor is coarse and the window must exceed any realistic DLQ replay delay).

The remaining non-atomic window (§4) is the trade-off chosen: **mark first, then apply** loses an event if the process dies between the two; **apply first, then mark** double-counts in the same situation. For revenue analytics, under-counting by one event on a crash — recoverable by backfill — beats silently inflating it.

## 6. Scale notes

- Writes: one indexed upsert + one insert per event. A single `mongod` handles thousands per second; the bottleneck will be `RABBITMQ_PREFETCH` × replicas, which is the knob.
- Reads: one indexed range scan returning ≤ 366 small documents.
- Hot documents: a busy restaurant's current day gets every one of its orders. `$inc` on one document is serialized by Mongo's document-level locking — fine at restaurant scale; `agg_platform_day` is the document to watch (shard by currency, or pre-aggregate per minute and roll up, if it ever matters).

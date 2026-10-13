# plan.md — what the video builds, what the students build

The video builds **one vertical slice, end to end**: one event in, one aggregate stored, one endpoint out, with every piece of cross-cutting infrastructure a real service needs. Everything else is homework — and is designed to be *repetition of the slice*, not new architecture.

## In the video (built, verified)

| Area | What exists |
| --- | --- |
| Publisher (order-service) | `events_outbox` migration (per shard, no `region` column); `lib/events/{event-types,types,outbox.repo,outbox-drain,jobs}.ts`; drain per region with `FOR UPDATE SKIP LOCKED`, bulk mark-published, break-on-publish-error, publish timeout; `order.placed` enqueued in the placement trx (COD) and in the capture trx (online); `RABBITMQ_ORDER_EVENTS_EXCHANGE`, `OUTBOUND_EVENTS_DRAIN_TICK_SEC`, `OUTBOUND_EVENTS_BATCH_SIZE`; worker registers the drain |
| `pkg/` | Mongo connect/ping/close; `Broker` Protocol + aio-pika impl (topology, DLX, consume, confirmed publish, stop); httpx client with retry |
| `lib/` | env, JSON logger, ContextVars, AppError + handlers + 500 boundary, envelope helpers, correlation + access log middleware, JWT auth, api-key guard, RBAC cache + guards, core client, generic event consumer with Mongo dedupe, composition root, graceful shutdown |
| `app/analytics` | `agg_restaurant_day` entity + repo + indexes; `event_ids` dedupe repo; `order.placed` handler; `AnalyticsService.on_order_placed` / `get_restaurant_days`; request/response DTOs; `GET /api/v1/analytics/restaurants/{restaurantId}/days?from=&to=` |
| `app/health` | `GET /health` |
| `play/` | `mock_core`, `mint_jwt`, `publish_test`, `check_mongo` |
| Docs | `CLAUDE.md`, `README.md`, this file, `docs/*` |

Acceptance: `docs/implementation-plan.md` Phases 1–6.

## Homework (documented, not built)

Ordered so each step reuses the one before. Prompts for each: `docs/ai-prompts.md`.

1. **`payment.completed` handler** — needs order-service to emit it first (enqueue in the webhook capture trx, next to `order.placed`). Decide what it adds to `agg_restaurant_day` (e.g. `online_paid_count`, `online_paid_sum`) — sums and counts only.
2. **`order.rejected` handler** — `rejected_count` on the restaurant-day. Bucket by the order's **`placedAt`** (carry it in the payload), not the rejection time, or the failure rate's numerator and denominator end up on different days.
3. **`order.delivered` handler** — `delivery_ms_sum += deliveredAt − placedAt`, `delivery_ms_count += 1`. **Out-of-order gotcha:** `delivered` can be consumed before `placed` (separate drain rows, a DLQ replay, a backfill). The upsert must work on a day that doesn't exist yet — `$inc` + `$setOnInsert` already does; never assume the `placed` side created the document. This is also why `_div_round_half_up` returns 0 for `orders_count == 0`.
4. **`agg_branch_day`** — same shape keyed `(branch_id, date)`. Same handlers, second `update_one`.
5. **`agg_product_day`** — keyed `(product_id, date)`, from `items[]`. **One upsert per line item → use `bulk_write([UpdateOne(...), ...], ordered=False)`**, one round trip per event, not N.
6. **`agg_platform_day`** — keyed `(date, currency)`: one row per day per currency. Never sum EGP and SAR.
7. **Seven endpoints**:
   - `GET /restaurants/{id}/days/failures` — failure rate = `rejected_count / orders_count`, **derived** in the service.
   - `GET /restaurants/{id}/days/delivery` — avg = `delivery_ms_sum / delivery_ms_count`, **derived**.
   - `GET /restaurants/{id}/branches/{branchId}/days` — `agg_branch_day`; needs a `require_branch_access` guard (port it from order-service's `rbac.ts`).
   - `GET /restaurants/{id}/products/top?from=&to=` — `agg_product_day` aggregation pipeline (`$match` → `$group` → `$sort` → `$limit`).
   - `GET /platform/days` — `agg_platform_day`, `system_admin` only.
   - `GET /platform/active-restaurants?date=` — distinct restaurants with `orders_count > 0` on a day; uses `idx_agg_restaurant_day_date_restaurant_id`.
   - `GET /restaurants/{id}/summary?from=&to=` — totals over the range, computed from the day rows.
   The two marked *derived* need **no new collection** — only fields on existing ones.
8. **`rbac.permissions_changed` consumer** — second `ConsumerOptions` on `core.events`, handler calls `PermissionsCache.invalidate(role)`. Note core doesn't emit this event today; adding it to core's outbox is part of the task.
9. **Backfill** — `cmd/backfill_aggs/main.py` (underscore: `python -m cmd.backfill-aggs.main` is not a valid module path): read orders from each order-service shard (read-only), replay them through `AnalyticsService` *without* the dedupe ledger, into fresh collections, then swap. Only works because the aggregates are sums and counts.

## Deliberately not in either list

Emitting events, Redis, multi-currency conversion, streaming/real-time, Mongo transactions (needs a replica set — see `docs/system-design.md` §4 for the one place it would help).

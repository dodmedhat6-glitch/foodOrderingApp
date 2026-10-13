# Implementation plan

Phases 1–6 are the video and are **done**; each acceptance check below was run against a live MongoDB 8.2 and RabbitMQ 4.3. Phases 7+ are homework (`plan.md`, prompts in `ai-prompts.md`). A phase is done when its checks pass — not when its code exists.

Common gate for every phase:
```bash
python -m compileall -q -x "\.venv" . && ruff check . && mypy .
```

---

## Phase 1 — Publisher in order-service

Mirror core's outbox into `order-service`.

1. Migration `20261013000000_create_events_outbox.ts` — per shard, no `region` column, partial index for the claim.
2. `lib/events/event-types.ts` (`order.placed`), `types.ts` (row, envelope, `OrderPlacedPayload`), `outbox.repo.ts` (enqueue / claim `FOR UPDATE SKIP LOCKED` / bulk mark published / mark failed), `outbox-drain.ts` (per region, break on publish error), `jobs.ts` (`registerOutboxDrainJobs`).
3. `pkg/messaging`: `declareExchange`, `publishTimeoutMs`.
4. Env: `RABBITMQ_ORDER_EVENTS_EXCHANGE`, `OUTBOUND_EVENTS_DRAIN_TICK_SEC`, `OUTBOUND_EVENTS_BATCH_SIZE`.
5. `app/order/events.ts` `enqueueOrderPlaced`, called in `placeOrder`'s trx (COD) and in `transitionInTrx` → `placed` (online capture).
6. `worker.ts`: `registerOutboxDrainJobs()`, declare exchange, close broker on shutdown.

**Acceptance**
- [x] `npx tsc --noEmit` clean.
- [ ] `REGION=eg npm run migrate` creates `events_outbox`; placing a COD order inserts one `pending` row in the same shard; within ~2 s the worker logs `outbox drain tick {published: 1}` and the row is `published`. *(Requires the order-service Postgres shards; not run in the video — the analytics side is tested with `play/publish_test.py`, which publishes the identical envelope.)*
- [ ] With RabbitMQ stopped: the row stays `pending`, `attempts` increments per tick, flips to `failed` at 5.

## Phase 2 — Skeleton: config, logging, boot

`pyproject.toml`, `.env.example`, `lib/config.py`, `lib/logger.py`, `server.py` (wiring, `/health`).

**Acceptance**
- [x] Missing `ACCESS_SECRET` → one JSON line `invalid environment` naming it, exit 1.
- [x] `python server.py` logs JSON lines; `GET /health` → `200 {"success":true,"data":{"status":"ok",...}}`.

## Phase 3 — Mongo: pkg client, entity, repo, indexes

`app/analytics/types.py` (entity), `app/analytics/repository.py` (`ensure_indexes`, repos).

**Acceptance**
- [x] Boot logs `mongo connected` then `mongo indexes ensured`.
- [x] `python -m play.check_mongo --indexes` lists `uq_agg_restaurant_day_restaurant_id_date`, `idx_agg_restaurant_day_date_restaurant_id`, `uq_event_ids_event_id`, `ttl_event_ids_received_at` (expireAfterSeconds 604800).
- [x] Restarting the service is a no-op for indexes.
- [x] `grep -rn "agg_\|event_ids" pkg` prints nothing.

## Phase 4 — Consumer: messaging, dedupe, handler, service write path

`pkg/messaging.py`, `lib/events.py`, `app/analytics/{errors,dto}.py`, `controller.py` `build_handlers`, `service.py` `on_order_placed`.

**Acceptance**
- [x] Boot logs `rabbit connected`, `event consumer started` with queue and bindings.
- [x] `publish_test --restaurant 42 --total 2500` → `orders_count: 1, revenue_sum: 2500`.
- [x] Same `--event-id` again → unchanged; log says `duplicate event, acking`.
- [x] `--total 1500` → `orders_count: 2, revenue_sum: 4000`.
- [x] `--raw '{"not":"an envelope"}'`, `--total -5`, and a routing-key/eventType mismatch each land in `analytics-service.order-events.dlq`; counts unchanged.
- [x] `--routing-key payment.completed` → `no handler for event type, acking`.
- [x] RabbitMQ down at boot → `rabbit not reachable at boot — retrying in background`, HTTP still serves.

## Phase 5 — Read path: auth, RBAC, DTOs, controller, routes

`lib/{auth,core_client,errors,http}.py`, `app/analytics/dto.py`, `controller.py` `build_router`, `service.py` `get_restaurant_days`.

**Acceptance** (with `play.mock_core` running)
- [x] No token → `401 UNAUTHENTICATED`; garbage cookie → 401; expired → 401.
- [x] Owner of 42 → `200 [{"date":…,"ordersCount":2,"revenueMinor":4000,"currency":"EGP","avgOrderMinor":2000}]`.
- [x] `from > to` → `400 ANALYTICS_INVALID_DATE_RANGE`; missing `from` → `400 VALIDATION_ERROR`; `restaurantId=abc` → 400 (one problem listed); `from=1760000000` → 400; span > 366 → `400 ANALYTICS_DATE_RANGE_TOO_LARGE`.
- [x] Restaurant with no data (as `system_admin`) → `200 []`.
- [x] Token for restaurant 7 → 403; `cashier` → 403; `customer` → 403.
- [x] mock-core prints one lookup per role while the cache is warm.
- [x] Every response has `X-CorrelationId`; every log line for the request carries the same `correlationId`.

## Phase 6 — Shutdown, play/, docs

`server.py` shutdown (`_Server`, consumer `stop()` with in-flight drain), `play/{mock_core,mint_jwt,publish_test,check_mongo}.py`, all docs.

**Acceptance**
- [x] Ctrl+C / CTRL_BREAK → `shutdown requested`, `event consumer stopped`, `shutdown complete`, exit code 0, no `rabbit disconnected` line.
- [x] README walkthrough reproduces Phases 3–5 from a clean database.
- [x] Layering greps (CLAUDE.md §3) print nothing.

`play/` scripts, for anyone regenerating them: **mock_core** — stdlib HTTP server on :3999 answering `GET /api/roles/{role}/permissions` with `{"success":true,"data":{"role","permissions":[{"permission"}]}}` (`owner`/`manager` → `analytics:read`, `cashier` → not), printing each hit. **mint_jwt** — PyJWT HS256 with `ACCESS_SECRET`, claims `user_id`, `email`, `role`, `iat`, `exp`, and for `restaurant_user` `restaurantId`, `restaurantRole`, `branchIds`; flags for each. **publish_test** — builds the `order.placed` envelope exactly as `order-service/src/app/order/events.ts` does, publishes via `pkg.messaging.amqp.AmqpBroker`; flags `--restaurant --total --currency --event-id --placed-at --routing-key --raw`. **check_mongo** — prints `agg_restaurant_day` (optionally one restaurant), `event_ids` count, `--indexes`, `--reset`.

---

## Phase 7 — Remaining event handlers (homework)

`order.rejected`, `order.delivered`, `payment.completed` — each needs its publisher change in order-service first.

**Acceptance**
- [ ] Each event type enqueued in the transaction that performs its transition; `tsc` clean.
- [ ] Each handler: payload model in `dto.py`, one service method, `$inc`/`$setOnInsert` upsert.
- [ ] `delivered` before `placed` produces the same final document as in order.
- [ ] Replays deduped; invalid payloads to DLQ.

## Phase 8 — More aggregates (homework)

`agg_branch_day`, `agg_product_day` (`bulk_write`, `ordered=False`), `agg_platform_day` (keyed by currency).

**Acceptance**
- [ ] Each collection's indexes in `repository.py` `ensure_indexes`, each with the query it serves.
- [ ] A 3-item order → exactly one round trip to `agg_product_day` (check with `mongod` log level 1 or a command listener).
- [ ] EGP and SAR events on the same day → two `agg_platform_day` documents.

## Phase 9 — More endpoints (homework)

The seven endpoints in `plan.md`.

**Acceptance**
- [ ] `failures` and `delivery` endpoints add no collection; values derived in the service; on-wire representation documented in `api-contracts.md`.
- [ ] Each endpoint: request DTO, response DTO, guards, every error code documented.
- [ ] No endpoint does more than one query per request (or one aggregation pipeline).

## Phase 10 — `rbac.permissions_changed` (homework)

**Acceptance**
- [ ] Separate queue on `core.events`; handler → `PermissionsCache.invalidate(role)`.
- [ ] Changing a role's permissions in core is reflected on the next request, not after the TTL.

## Phase 11 — Backfill (homework)

**Acceptance**
- [ ] `python backfill.py` rebuilds into `*_rebuild` and swaps, reusing `server.py`'s constructors.
- [ ] Running it twice gives identical results; live consumption during the rebuild is not double-counted.

# CLAUDE.md — analytics-service

The Python sibling of `core-service` and `order-service`. Same layering, envelopes, auth contract and messaging patterns; when something isn't written here, do what `order-service` does, translated (`docs/node-to-python-mapping.md`).

## 1. Mission

- **Consumes** order-service events from RabbitMQ (`order.events`).
- **Upserts** per-day rollups into MongoDB.
- **Serves** them read-only under `/api/v1/analytics/...`.

Owns no operational data, writes to no other store, emits no events. Its Mongo is derived: losing it costs a backfill.

## 2. Stack (locked)

Python ≥ 3.11 asyncio · FastAPI + uvicorn · pymongo `AsyncMongoClient` · aio-pika · pydantic v2 + pydantic-settings · PyJWT · httpx · stdlib `logging` (JSON) · ruff · mypy `--strict`.

**Forbidden:** any ODM (Beanie, MongoEngine, Motor, ODMantic, SQLAlchemy), DI frameworks, migration tools, Redis.

## 3. Layout

```
server.py              # wiring + FastAPI app + /health + serve + shutdown (≈ server.ts/app.ts/routes.ts)
pkg/messaging.py       # aio-pika client; app-agnostic
lib/                   # app-aware glue, one file per concern
  config.py logger.py errors.py http.py auth.py core_client.py events.py
app/analytics/         # the module
  types.py errors.py dto.py repository.py service.py controller.py
play/                  # gitignored dev aids
```

Annotated: `docs/folder-structure.md`.

**Layering:** `app → lib, pkg` · `lib → pkg` (never `app`) · `pkg →` nothing of ours. Only `server.py` imports everything. When `lib/` needs an `app/` capability it declares a small `Protocol` (e.g. `lib.events.EventDeduper`, satisfied by `EventIdsRepo`). No collection, queue or exchange names in `pkg/`.

**Keep it small.** One file per concern; split a file only when it stops being readable. No abstraction with a single implementation unless it breaks an import cycle between layers.

## 4. Module conventions (`app/<module>/`)

| File | Holds |
| --- | --- |
| `types.py` | entity dataclasses + constants (permissions, event types) |
| `errors.py` | `ERR_… = AppError(code, status, message)` |
| `dto.py` | request query/body models, response DTOs (`from_entity`), inbound event payload models |
| `repository.py` | **the only pymongo code**: collection names, `ensure_indexes`, one repo class per collection |
| `service.py` | the service class: business rules, raises `AppError`, returns DTOs (like order-service services) |
| `controller.py` | `build_router(service, auth)` and `build_handlers(service)` — thin: validated input → one service call |

No dataclass/`BaseModel` declared in `service.py`, `controller.py` or `repository.py`.

Naming: `snake_case` files/functions, `PascalCase` classes, `ERR_`/`PERM_` constants. Wire and log keys are camelCase (pydantic aliases translate); Mongo fields snake_case; indexes `uq_/idx_/ttl_<collection>_<fields>`.

## 5. Responses

```json
{"success": true,  "data": ...}
{"success": false, "error": {"code": "...", "message": "...", "details": {...}?}}
```

- Success only via `lib.http.send_success(dto)`; `data` is a response DTO or a list of them, never an entity/dict (`/health` is the infra exception).
- Errors only via `lib/errors.py` — code raises `AppError`; validation → `400 VALIDATION_ERROR`; bugs → `500 INTERNAL_ERROR` (in `RequestMiddleware`).
- Money: integer minor units + `currency`. Days `YYYY-MM-DD` UTC. Derived figures (averages, rates) computed on read, never stored.

## 6. MongoDB

- Indexes live in `repository.ensure_indexes`, run at boot (idempotent). Each names the query it serves; equality fields then range. Changing an existing index's options needs `collMod`/drop.
- Every read has a projection. Arithmetic on the server: one `update_one(..., upsert=True)` with `$inc`/`$setOnInsert`/`$set`, never read-modify-write.
- Store sums + counts, never averages. Bucket by the event's own timestamp (UTC), not processing time.
- tz-aware datetimes only (`tz_aware=True`, `datetime.now(UTC)`). No multi-document transactions (standalone mongod).

## 7. Cross-cutting

- **Config:** `lib/config.py` `Env` is the only reader of the environment. New var = one field + one line in `.env.example`. `server.py` passes values to constructors; nothing imports a global env.
- **Logging:** `logger.info("msg", key=value)`. `correlationId` is added automatically from the ContextVar set by `RequestMiddleware` (HTTP) or the consumer (events).
- **Auth:** HS256 `ACCESS_SECRET` (same as core/order); cookie `access_token`, then Bearer; core's claims (`user_id`, `role`, `restaurantId`, `restaurantRole`). Every failure → 401.
- **RBAC:** `auth.require("analytics:read")` — admins pass, restaurant users need it on their restaurant role; `auth.require_restaurant_member()` scopes to the path's `restaurantId`. Permissions from core `GET /api/roles/{role}/permissions` via `PermissionsCache` (in-process TTL, single-flight). `invalidate(role)` is for the homework consumer.
- **Events:** queue `analytics-service.order-events` on `order.events`, bindings `order.#,payment.#`, own DLX/DLQ, at-least-once, manual ack. Bad envelope or routing key ≠ `eventType` → DLQ; no handler → ack; duplicate (`event_ids`, unique, 7-day TTL) → ack; handler error → `forget` + DLQ. Why Mongo dedupe: `docs/system-design.md` §5.
- **Shutdown:** stop HTTP → stop consumer + drain in-flight → close broker, core client, Mongo.

## 8. Performance

One indexed query per read; one upsert + one dedupe insert per event (`bulk_write` when an event touches many docs). RBAC hit costs no I/O. Ranges capped at 366 days. Concurrency per replica = `RABBITMQ_PREFETCH`.

## 9. Avoid

ODMs and DI frameworks · pymongo outside `repository.py` · entities/dicts from routes · logic in routes or handlers · `except: pass` (shutdown aside) · floats or `round()` for money · naive datetimes · blocking calls in `async def` · `BaseHTTPMiddleware` · `os.environ` outside `lib/config.py` · new files for a few lines.

Done means: `python -m compileall -q -x "\.venv" . && ruff check . && mypy .` clean **and** the change exercised with `play/` (README).

## 10. Docs

`README.md` (run it) · `plan.md` (video vs homework) · `docs/folder-structure.md` · `docs/system-design.md` · `docs/api-contracts.md` · `docs/node-to-python-mapping.md` · `docs/ai-prompts.md` · `docs/implementation-plan.md`.

## 11. Out of scope

Owning operational data · emitting events · Redis · currency conversion · real-time/streaming · Mongo replicas/sharding · deploy/observability.

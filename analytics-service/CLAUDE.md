# CLAUDE.md — analytics-service Guidelines

Rules for the **`analytics-service`** of the **QuickBite** platform. It is the Python sibling of `core-service` and `order-service` (both Node + TypeScript), and it **mirrors their architecture deliberately**: same layering, same envelopes, same auth contract, same messaging patterns. When a decision is not written here, find how `order-service` makes it and translate that (`docs/node-to-python-mapping.md`). Deviate only where this file says so.

---

## 1. Mission

Owns **per-day rollups** of order activity:

- **Consumes** events from `order-service` over RabbitMQ (exchange `order.events`).
- **Upserts** day-grained aggregates into MongoDB.
- **Serves** read-only HTTP endpoints under `/api/v1/analytics/...`.

It does **not** own users, restaurants, products, orders or payments. It never writes to another service's store, and it **emits no events**. Its Mongo database is derived data: losing it costs a backfill (`cmd/backfill_aggs/`, homework), not truth.

---

## 2. Tech stack (locked)

| Concern        | Choice                                                     |
| -------------- | ---------------------------------------------------------- |
| Runtime        | Python ≥ 3.11, asyncio                                     |
| HTTP           | `fastapi`, served by `uvicorn` (started from `lib/boot`)   |
| DB             | `pymongo` ≥ 4.13, **`AsyncMongoClient`** (no Motor)        |
| Messaging      | `aio-pika` (`connect_robust`)                              |
| Config         | `pydantic-settings`                                        |
| Validation/DTO | `pydantic` v2                                              |
| JWT            | `PyJWT` (HS256 pinned)                                     |
| HTTP client    | `httpx` (wrapped by `pkg/httpclient`)                      |
| Logging        | stdlib `logging` + JSON formatter (`lib/logger`)           |
| DI             | **None.** Constructor wiring in `lib/boot/boot.py`         |
| Lint / types   | `ruff`, `mypy --strict` (config in `pyproject.toml`)       |

**Forbidden:** SQLAlchemy, Beanie, MongoEngine, ODMantic, Motor, any ODM; DI frameworks (`dependency-injector`, `punq`, …); DDL-style migration tools. Repositories use pymongo directly with dataclass entities and explicit mappers — the analogue of "Knex, not an ORM".

---

## 3. Folder structure

```
analytics-service/
  cmd/api/main.py              # entry point: calls lib.boot.boot.run(). Never grows.
  pkg/                         # framework-free, app-agnostic
    mongo/                     # connect/ping/close. Knows NO collection names.
    messaging/                 # Broker Protocol (types.py) + aio-pika impl (amqp.py)
    httpclient/                # httpx wrapper: timeout, retry on 5xx/transport, typed errors
  lib/                         # app-aware glue
    boot/                      # composition root (boot.py) + GracefulServer (server.py)
    config/env.py              # _Settings schema + load() -> frozen Env
    logger/logger.py           # JSON logging, Logger wrapper, from_context()
    appcontext/context.py      # ContextVars: correlation id, claims (≈ express.d.ts)
    errors/                    # AppError, cross-cutting ERR_*, install()/wrap()
    http/response.py           # send_success, send_paginated
    middleware/correlation.py  # CorrelationMiddleware, AccessLogMiddleware (pure ASGI)
    auth/                      # Authenticate (JWT), RequireApiKey, ERR_UNAUTHENTICATED
    rbac/                      # PermissionsCache (in-process, TTL, single-flight) + Rbac guards
    coreclient/                # CoreClient + CoreRbacClient (role -> permissions from core)
    coreevents/                # EventConsumer (generic), Envelope, EventHandler, EventDeduper
  app/
    analytics/
      types.py enums.py errors.py   # shared by every subpackage below
      entity/ repository/ service/ controller/ dto/ eventhandlers/
    health/                    # GET /health
  play/                        # GITIGNORED dev aids: mock_core, mint_jwt, publish_test, check_mongo
```

Annotated version: `docs/folder-structure.md`. Every directory is a package (`__init__.py`).

### Layering

```
app/  -> may import lib, pkg
lib/  -> may import pkg; may NOT import app/   (exception: lib/boot, the composition root)
pkg/  -> imports nothing from lib or app; no env, no globals, no app knowledge
```

- `pkg/` has no idea this service exists. **A collection, queue or exchange name in `pkg/` is a bug.** Names arrive as constructor arguments.
- When `lib/` needs something `app/` provides, `lib/` declares a `typing.Protocol` and `app/` satisfies it structurally (no import, no subclass). Examples: `EventDeduper` (consumer) ← `EventIDsRepo`; `PermissionsLoader` (rbac cache) ← `CoreRbacClient`.
- Check: `grep -rnE "^(from|import) (lib|app)\b" pkg` and `grep -rnE "^(from|import) app\b" lib | grep -v lib/boot` must both be empty.

---

## 4. Naming

- Files and modules: `snake_case.py`. A file is named for its one class: `analytics_service.py` → `AnalyticsService`, `agg_restaurant_day_repo.py` → `AggRestaurantDayRepo`.
- Suffixes: `*_service.py`, `*_controller.py`, `*_repo.py`, `*_request.py`, `*_response.py`. `routes.py`, `handlers.py`, `payloads.py`, `indexes.py`.
- Classes `PascalCase`; functions/attributes `snake_case`; constants `UPPER_SNAKE`.
- Errors: `ERR_<WHAT>` instances; codes `UPPER_SNAKE`, module-prefixed for module errors (`ANALYTICS_INVALID_DATE_RANGE`).
- Permissions: `PERM_<RESOURCE>_<ACTION> = "<resource>:<action>"` in `enums.py`.
- **Wire names are camelCase, Python names are snake_case.** Pydantic aliases (`alias_generator=to_camel`, `Field(alias="from")`) translate at the edge. Log field keys are camelCase too (`correlationId`), so one log query covers all three services.
- Mongo: collections `snake_case`, prefixed by kind (`agg_…`); fields `snake_case`; indexes `uq_<coll>_<fields>`, `idx_<coll>_<fields>`, `ttl_<coll>_<field>`.

---

## 5. Module file conventions (`app/<module>/`)

| File / package          | Holds                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `types.py`              | Dataclasses shared across subpackages (`OnOrderPlacedInput`, `RestaurantDayRow`, `DateRange`) |
| `enums.py`              | `StrEnum`s and permission constants                                      |
| `errors.py`             | `ERR_… = AppError(code, status, message)` — module-level instances only  |
| `entity/`               | `@dataclass(frozen=True)` per stored document. No pymongo, no methods that do I/O |
| `repository/`           | **The only place pymongo appears.** One class per collection, `_PROJECTION`, `_to_entity`, plus `collections.py` and `indexes.py` |
| `service/`              | The service class and nothing else. Raises `AppError`, returns plain types |
| `dto/*_request.py`      | Pydantic models validated by FastAPI (query/body)                        |
| `dto/*_response.py`     | Pydantic models with a `from_row`/`from_entity` classmethod — the wire contract |
| `controller/*_controller.py` | Class; methods: inputs → one service call → DTOs → `send_success` |
| `controller/routes.py`  | `build_router(controller, rbac)` — path, guards, handler. Mounted by `lib/boot` |
| `eventhandlers/handlers.py` | `build_handlers(service) -> {event_type: handler}`                   |
| `eventhandlers/payloads.py` | Pydantic models for inbound event payloads (mirror the publisher's TS types) |

**Never declare a dataclass, `BaseModel`, `TypedDict` or `NamedTuple` inside `*_service.py`, `*_controller.py` or `*_repo.py`.** Module-shared types → `app/<module>/types.py`; cross-cutting → `lib/<area>/types.py` or `payloads.py`.

### Adding a module — order of work (same as the Node services)

1. Entity dataclass → 2. collection name + indexes in `repository/` → 3. repository class → 4. request/response DTOs → 5. `types.py`/`errors.py`/`enums.py` entries → 6. service → 7. controller + `routes.py` → 8. event handlers (if any) → 9. wire everything in `lib/boot/boot.py` → 10. smoke-test with `play/` before moving on.

---

## 6. Response shape

```json
{"success": true,  "data": ...}
{"success": true,  "data": [...], "meta": {...}}
{"success": false, "error": {"code": "...", "message": "...", "details": {...}?}}
```

- Success responses are built **only** by `lib.http.response.send_success` / `send_paginated`, and `data` is **always** a response DTO or a list of them. Never an entity, never a dict.
- Error responses are built **only** by `lib/errors/handler.py`. Services and controllers `raise`, never return an error body.
- Money: **integer minor units** with `currency` next to it. Never floats, never formatted.
- Dates: `YYYY-MM-DD` (UTC day). Timestamps: ISO-8601 UTC.
- Derived figures (averages, rates) are computed in the **service** from stored sums and counts.

---

## 7. MongoDB rules

- **No migrations.** Indexes are declared in `app/<module>/repository/indexes.py` and created by `ensure_indexes(db)` at boot. `create_index` is idempotent for identical specs; **changing** an existing index's options raises `IndexOptionsConflict` — use `collMod` (TTL) or drop-and-recreate deliberately.
- **Every index names its query** in a comment. Equality fields first, then range. No speculative indexes.
- **Every read has a projection** (`_PROJECTION`, excluding `_id`). No whole-document fetches.
- **Arithmetic happens on the server.** `$inc`, `$setOnInsert`, `$set` in one `update_one(..., upsert=True)`. Never read-modify-write in Python.
- **Store sums and counts, never averages.** Rollups must merge associatively across replays and backfills.
- **Identity of a rollup row is a unique index** (`(restaurant_id, date)`), which also makes concurrent first-upserts safe.
- **Day buckets are UTC** `YYYY-MM-DD` strings, derived from the event's own timestamp (`placedAt`), never from the time we processed it.
- Datetimes are stored and read **tz-aware** (`AsyncMongoClient(tz_aware=True)`; `datetime.now(UTC)`).
- No multi-document transactions (a standalone `mongod` doesn't support them). Design writes to be single-document atomic.

---

## 8. Cross-cutting infra

### Config
All configuration goes through `lib/config/env.py`: a field on `_Settings`, a line in `load()`, a line in `.env.example`. **Never read `os.environ` elsewhere.** Components receive the slice of `Env` they need in their constructor; nothing imports a global env.

### Logging
`from lib.logger.logger import logger, from_context`. `logger.info("message", key=value)`. Inside a request or message, use `from_context()` — it adds `correlationId` (and `userId`). JSON to stdout; uvicorn/aio-pika/pymongo records go through the same handler.

### Correlation
`CorrelationMiddleware` reads `X-CorrelationId`/`X-Correlation-Id` or mints a UUID, stores it in a ContextVar, echoes it on the response. The consumer sets it per message (envelope `correlationId`, else `eventId`). `CoreClient` forwards it to core.

### Auth
- JWT HS256 with `ACCESS_SECRET` (identical to core/order). Token from cookie `access_token` first, then `Authorization: Bearer`.
- Claims on the wire are core's: `user_id`, `role`, `email`, `restaurantId?`, `restaurantRole?`, `branchIds?`. `lib/auth/jwt.py` maps them to `Claims`.
- Every failure (missing, garbage, expired, wrong shape) is the same `401 UNAUTHENTICATED`.

### RBAC
- No permissions catalog here. `Rbac.require("analytics:read")`: `system_admin` passes; `restaurant_user` passes if their **restaurant role**'s permissions include it; everyone else 403.
- Permissions come from core's `GET /api/roles/{role}/permissions` through `PermissionsCache` (in-process, TTL `RBAC_CACHE_TTL_SEC`, single-flight per role).
- Tenant scope: `Rbac.require_restaurant_member()` compares the path's `restaurantId` to the token's. Order on a route: member check, then permission.
- `rbac.permissions_changed` consumer → `PermissionsCache.invalidate(role)` is **homework**; until then the TTL is the only invalidation.

### Messaging (inbound)
- Exchange `order.events` (topic, durable; owned by order-service, asserted here idempotently). Queue `analytics-service.order-events` (durable). Bindings `order.#`, `payment.#`. DLX `analytics-service.order-events.dlx` → DLQ `analytics-service.order-events.dlq`.
- **At-least-once.** Manual ack after the handler returns.
- Per message: bad envelope → DLQ; routing key ≠ `eventType` → DLQ; no handler → log + ack; `mark_seen` false → ack (duplicate); handler raises → `forget(eventId)` + DLQ; else ack.
- **Dedupe is Mongo, not Redis:** `event_ids` with a unique index on `event_id` and a 7-day TTL on `received_at`. Reasoning in `docs/system-design.md` §5.
- Handlers are thin: validate payload (pydantic) → build a `types.py` input → one service call. A handler never touches a repository.

### Errors
- `AppError(code, status, message, details?)`. Canonical cases are module-level `ERR_…` instances; `raise ERR_X` or `raise ERR_X.with_details(...)` (never mutate the shared instance).
- `errors.install(app, logger)` handles `AppError`, `RequestValidationError` (→ `400 VALIDATION_ERROR`), `HTTPException` (404/405). `errors.wrap(app, logger)` is the 500 boundary for everything else.

### Shutdown
SIGINT/SIGTERM (CTRL_BREAK on Windows): HTTP stops accepting → consumer cancelled and in-flight messages drained (bounded) → broker closed → HTTP client closed → Mongo closed → `shutdown complete`. `GracefulServer` stops uvicorn from re-raising the signal over this sequence.

---

## 9. Performance budget

- Read endpoints: **p95 < 50 ms** at the service, one indexed query each, no N+1 (one `find` per request, never a loop of `find_one`s).
- Event handling: **one** Mongo write per aggregate per event (plus the dedupe insert). `agg_product_day` (homework) is one upsert *per line item* → use `bulk_write`, one round trip.
- `RABBITMQ_PREFETCH` (32) bounds concurrency per replica.
- Query windows are bounded: `ANALYTICS_MAX_RANGE_DAYS` (366).
- The RBAC check costs zero network calls on a cache hit.

---

## 10. Code style — what to avoid

- ❌ An ODM, a DI framework, or global singletons with state (the module-level `logger` is the one stateless exception).
- ❌ pymongo imports outside `repository/` (and `pkg/mongo`, `play/`).
- ❌ Returning entities or dicts from controllers. DTOs only.
- ❌ Business rules in controllers, handlers or routes.
- ❌ `try/except` that logs and continues. Re-raise, or convert to `AppError`.
- ❌ `except Exception: pass` anywhere except shutdown cleanup.
- ❌ Floats for money. `round()` for money (banker's rounding) — use integer arithmetic.
- ❌ Naive datetimes. Always `datetime.now(UTC)`, `tz_aware=True`.
- ❌ Blocking calls in `async def` (`requests`, `time.sleep`, sync pymongo). Ruff's `ASYNC` rules catch most.
- ❌ `BaseHTTPMiddleware` — use pure ASGI middleware (ContextVar propagation).
- ❌ Reading `os.environ` outside `lib/config/env.py`.
- ❌ Inline data classes in service/controller/repo files.
- ❌ Adding wiring to `cmd/api/main.py`.

Before calling work done: `python -m compileall -q . && ruff check . && mypy .` clean, and the slice exercised with `play/` (README).

---

## 11. Reference docs

- `README.md` — run it locally.
- `plan.md` — what the video builds vs. homework.
- `docs/folder-structure.md` — annotated tree.
- `docs/system-design.md` — platform diagram, flows, failure modes, dedupe rationale.
- `docs/api-contracts.md` — endpoints, payloads, every error code, the event contract.
- `docs/node-to-python-mapping.md` — TS idiom → Python idiom, layer by layer.
- `docs/ai-prompts.md` — prompt templates for the homework.
- `docs/implementation-plan.md` — phases with acceptance checks.

---

## 12. Out of scope

- Owning or writing any operational data (orders, payments, users, …).
- Emitting events. Nothing consumes from this service.
- Redis. The RBAC cache is in-process; dedupe is in Mongo.
- Real-time/streaming analytics, WebSockets, dashboards UI.
- Multi-currency conversion. A restaurant-day has the currency of its first event.
- Read replicas, sharding Mongo, change streams.
- Deployment, observability stack, load testing.

# Folder structure

```
analytics-service/
├── cmd/
│   └── api/
│       └── main.py                 # `python -m cmd.api.main`. Calls lib.boot.boot.run(). Nothing else, ever.
│
├── pkg/                            # ── framework-free, app-agnostic. Imports nothing from lib/ or app/.
│   ├── mongo/
│   │   ├── types.py                #   MongoConfig, Document, Database aliases
│   │   └── client.py               #   MongoClient: connect() (+ ping), db, ping(), close(). No collection names.
│   ├── messaging/
│   │   ├── types.py                #   Broker Protocol, AmqpConfig, ConsumerOptions, ConsumeMessage, StateListener
│   │   └── amqp.py                 #   AmqpBroker (aio-pika connect_robust): topology+DLX, consume, confirmed publish, stop
│   └── httpclient/
│       ├── types.py                #   HttpClientConfig
│       ├── errors.py               #   HttpStatusError (4xx), HttpUnavailableError (5xx/transport after retries)
│       └── client.py               #   HttpClient.request_json: timeout, retry w/ backoff on 5xx + transport errors
│
├── lib/                            # ── app-aware glue. Imports pkg/. Never app/ (except boot/).
│   ├── boot/
│   │   ├── boot.py                 #   THE composition root: constructs and wires every object, serves, shuts down
│   │   └── server.py               #   GracefulServer: uvicorn.Server minus the post-shutdown signal re-raise
│   ├── config/env.py               #   _Settings (schema) + load() -> frozen Env (nested groups)
│   ├── logger/logger.py            #   JSON formatter, Logger(info/warn/error/debug, bind), from_context(), configure()
│   ├── appcontext/context.py       #   ContextVars correlation_id + claims; Claims dataclass (≈ express.d.ts)
│   ├── errors/
│   │   ├── apperror.py             #   AppError(code, status, message, details) + with_details()
│   │   ├── errors.py               #   cross-cutting ERR_VALIDATION / NOT_FOUND / METHOD_NOT_ALLOWED / INTERNAL
│   │   └── handler.py              #   install(): exception handlers; wrap(): 500 boundary middleware
│   ├── http/response.py            #   send_success, send_paginated
│   ├── middleware/correlation.py   #   CorrelationMiddleware, AccessLogMiddleware (pure ASGI)
│   ├── auth/
│   │   ├── types.py                #   AccessTokenClaims — core's claim set exactly as signed
│   │   ├── jwt.py                  #   verify_access_token (HS256 pinned) -> Claims
│   │   ├── middleware.py           #   Authenticate: cookie, then Bearer -> Claims (FastAPI dependency)
│   │   ├── apikey.py               #   RequireApiKey: inbound internal calls (unused by the slice)
│   │   └── errors.py               #   ERR_UNAUTHENTICATED, ERR_PERMISSION_DENIED
│   ├── rbac/
│   │   ├── cache.py                #   PermissionsLoader Protocol; PermissionsCache (TTL, single-flight, invalidate)
│   │   └── middleware.py           #   Rbac.require(perm), Rbac.require_restaurant_member()
│   ├── coreclient/
│   │   ├── client.py               #   CoreClient: x-api-key, correlation header, {success,data} unwrap, AppError mapping
│   │   ├── rbac.py                 #   CoreRbacClient.get_role_permissions -> frozenset (satisfies PermissionsLoader)
│   │   ├── types.py                #   RolePermissionsLookup — core's response contract
│   │   └── errors.py               #   ERR_CORE_UNAVAILABLE (503), ERR_CORE_BAD_RESPONSE (502)
│   └── coreevents/
│       ├── payloads.py             #   Envelope, EventMeta, EventHandler type
│       └── consumer.py             #   EventDeduper Protocol; EventConsumer: parse, route, dedupe, dispatch, ack/nack, stop
│
├── app/                            # ── business modules. Import lib/ and pkg/.
│   ├── analytics/
│   │   ├── types.py                #   OnOrderPlacedInput, DateRange, RestaurantDayRow — shared by every subpackage
│   │   ├── enums.py                #   PERM_ANALYTICS_READ, OrderEventType
│   │   ├── errors.py               #   ERR_INVALID_DATE_RANGE, ERR_DATE_RANGE_TOO_LARGE, ERR_INVALID_EVENT_PAYLOAD
│   │   ├── entity/
│   │   │   └── agg_restaurant_day.py   # AggRestaurantDay dataclass
│   │   ├── repository/             #   ONLY place pymongo is used by the app
│   │   │   ├── collections.py      #     collection names
│   │   │   ├── indexes.py          #     ensure_indexes(db): every index, with the query it serves
│   │   │   ├── agg_restaurant_day_repo.py  # add_placed_order ($inc upsert), find_range
│   │   │   └── event_ids_repo.py   #     mark_seen / forget (satisfies EventDeduper)
│   │   ├── service/
│   │   │   └── analytics_service.py    # AnalyticsService — the class and nothing else
│   │   ├── dto/
│   │   │   ├── restaurant_days_request.py   # RestaurantDaysQuery (?from=&to=)
│   │   │   └── restaurant_days_response.py  # RestaurantDayResponse.from_row
│   │   ├── controller/
│   │   │   ├── analytics_controller.py # AnalyticsController
│   │   │   └── routes.py           #     build_router(controller, rbac)
│   │   └── eventhandlers/
│   │       ├── payloads.py         #     OrderPlacedPayload — mirrors order-service's TS type
│   │       └── handlers.py         #     build_handlers(service) -> {"order.placed": ...}
│   └── health/
│       ├── dto/health_response.py
│       └── routes.py               #   GET /health
│
├── play/                           # GITIGNORED dev aids — see below
│   ├── mock_core.py                #   fake core: GET /api/roles/{role}/permissions on :3999
│   ├── mint_jwt.py                 #   sign a core-shaped access token with ACCESS_SECRET
│   ├── publish_test.py             #   publish an order.placed envelope (or --raw garbage)
│   └── check_mongo.py              #   print agg docs / event_ids count / indexes; --reset
│
├── docs/                           # this folder
├── pyproject.toml  uv.lock         # deps, ruff + mypy config
├── .env.example  .gitignore
└── CLAUDE.md  README.md  plan.md
```

## Why things are where they are

**`cmd/api/main.py` is three lines.** An entry point that wires things grows every time a singleton is added, and two entry points (API, backfill) would each re-wire the world. The process hands control to `lib/boot` and nothing else. A second process (`cmd/backfill_aggs/main.py`) gets its own small `run()` that reuses the same constructors.

**`lib/boot` may import `app/`; nothing else in `lib/` may.** Something has to put modules and infrastructure together. In the Node services that is `lib/di/container.ts`; here it is a function you can read top to bottom.

**Indexes live in `app/analytics/repository/indexes.py`, not `pkg/mongo/`.** `pkg/mongo` knows how to connect to *a* Mongo. That this service has an `agg_restaurant_day` collection with a unique `(restaurant_id, date)` is application knowledge, owned by the code that queries it. If an index and the query it serves are in different layers, one of them will drift.

**`types.py`, `errors.py`, `enums.py` sit in `app/analytics/`, not in `service/`.** The service, the controller, the DTOs and the event handlers all need `RestaurantDayRow` or `ERR_INVALID_DATE_RANGE`. Putting them in the parent package gives every subpackage one import path, and keeps `service/analytics_service.py` about the service.

**Protocols in `lib/`, implementations in `app/`.** The event consumer needs "have I seen this id?". It declares `EventDeduper`; `EventIDsRepo` happens to have matching methods. No import arrow points from `lib/` to `app/`, and the consumer can be driven in a test by any object with `mark_seen`/`forget`.

**`play/` instead of `cmd/`.** The four scripts make the slice testable without Postgres, core-service or order-service. They are not part of the service and must not look like it: `cmd/` means "this is a process we deploy". Gitignored so they never ship.

**Package named `cmd` shadows the stdlib `cmd` module.** Running from the service root puts the root first on `sys.path`, so `import cmd` finds ours — and `pdb` (whose `Pdb` class subclasses stdlib `cmd.Cmd`) fails to import: `AttributeError: module 'cmd' has no attribute 'Cmd'`. That includes `breakpoint()`, which imports `pdb`. Debug with your IDE's debugger (debugpy doesn't use `cmd`). Kept for symmetry with the platform's `cmd/` + `pkg/` layout; if it bites, renaming the directory to `entrypoints/` costs one line in the README. See `node-to-python-mapping.md` §Gotchas.

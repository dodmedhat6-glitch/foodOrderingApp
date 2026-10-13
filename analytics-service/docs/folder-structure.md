# Folder structure

```
analytics-service/
├── server.py               # THE entry point: python server.py
│                           #   create_app(): FastAPI + error handlers + RequestMiddleware + /health + routers
│                           #   main(): Env -> Mongo (ping, ensure_indexes) -> service -> auth -> consumer
│                           #           -> uvicorn -> on exit: consumer.stop, broker/core/mongo close
│
├── pkg/
│   └── messaging.py        # AmqpBroker (aio-pika connect_robust): consume w/ topology+DLX, publish, stop
│
├── lib/
│   ├── config.py           # Env (pydantic-settings): every env var, validated at boot
│   ├── logger.py           # JSON logging, `logger`, `correlation_id` ContextVar
│   ├── errors.py           # AppError, common ERR_*, render(), install_error_handlers()
│   ├── http.py             # send_success(), RequestMiddleware (correlation id, 500 boundary, access log)
│   ├── auth.py             # Claims, PermissionsCache, Auth.authenticate / require / require_restaurant_member
│   ├── core_client.py      # CoreClient: x-api-key, retry on 5xx, {success,data} unwrap, get_role_permissions
│   └── events.py           # EventConsumer (parse, route, dedupe, dispatch, ack/nack, stop), EventDeduper Protocol
│
├── app/
│   └── analytics/
│       ├── types.py        # AggRestaurantDay entity, PERM_ANALYTICS_READ, ORDER_PLACED
│       ├── errors.py       # ERR_INVALID_DATE_RANGE, ERR_DATE_RANGE_TOO_LARGE, ERR_INVALID_EVENT_PAYLOAD
│       ├── dto.py          # RestaurantDaysQuery, RestaurantDayResponse, OrderPlacedPayload
│       ├── repository.py   # ensure_indexes, AggRestaurantDayRepo, EventIdsRepo — only pymongo code
│       ├── service.py      # AnalyticsService.on_order_placed / get_restaurant_days
│       └── controller.py   # build_router (HTTP) + build_handlers (events)
│
├── play/                   # GITIGNORED: mock_core, mint_jwt, publish_test, check_mongo
├── docs/
├── pyproject.toml  uv.lock  .env.example  .gitignore
└── CLAUDE.md  README.md  plan.md
```

## Why it looks like this

**`server.py` at the root**, like `server.ts` in the Node services: one file you open to see every object the process creates, in order, and how it shuts down. It also holds `create_app` (the Node services' `app.ts`); it can't be a root `app.py` because that name is taken by the `app/` package.

**One file per concern, not one per class.** `lib/auth.py` holds the claims, the permission cache and the guards because they're one feature; splitting them into a package of five files bought nothing but navigation.

**`pkg/` has one file** because the AMQP client is the only piece that's reusable as-is in another service. Mongo needs no wrapper (`AsyncMongoClient` + a `ping` in `server.py`), and the HTTP client lives in `lib/core_client.py`, its only user.

**Indexes live in `app/analytics/repository.py`,** next to the queries they serve. `pkg/` knows nothing about this service's collections.

**`lib/events.py` declares `EventDeduper`; `app/analytics/repository.EventIdsRepo` satisfies it** without importing it. That keeps the `lib → app` arrow from existing while the Mongo code stays in `app/`.

**`play/` is gitignored** so dev aids never look like production entry points.

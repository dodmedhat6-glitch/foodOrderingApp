# Folder Structure — `order-service`

Mirrors `core-service` exactly. The differences are documented inline.

---

## Tree (as built, end of Phase 3)

Everything below exists on disk unless marked `# PHASE 5`. Where an earlier
draft of this file predicted a file that was never built, the reason it was
dropped is noted inline — the omissions are design decisions, not gaps.

```
order-service/
├── .env
├── .gitignore
├── package.json
├── tsconfig.json
├── tsconfig.scripts.json            # scripts/ + play/ compile under their own config
├── CLAUDE.md
├── docs/
│   ├── api-contracts.md
│   ├── business-logic/
│   │   ├── orders.md
│   │   ├── payments.md
│   │   ├── deliveries.md
│   │   ├── agents.md
│   │   ├── restaurant-finance.md
│   │   └── rbac.md
│   ├── database-design.md
│   ├── folder-structure.md
│   ├── implementation-plan.md
│   └── system-design.md
├── scripts/
│   └── migrate-all.ts               # runs knex migrations across every region shard
├── play/                            # throwaway probes, run with ts-node; not tests
│   ├── test-kashier-signature.ts    # pinned to Kashier's published HMAC vector
│   ├── test-delivery-cycle.ts       # presence → offer → claim → delivered → earning
│   ├── test-order-cycle.ts, test-payment-cycle.ts, test-core-events.ts, ...
│   └── README.md
└── src/
    ├── app.ts                       # express composition (cors, helmet, json, cookie, correlation, routes, errorHandler)
    ├── server.ts                    # bootstrap: HTTP + WS attach + 4 jobs + core-events consumer + graceful shutdown
    ├── routes.ts                    # mounts every module router under /api
    │
    ├── app/                         # business modules
    │   ├── health/
    │   │   └── health.routes.ts
    │   │
    │   ├── order/
    │   │   ├── controller/order.controller.ts
    │   │   ├── service/order.service.ts
    │   │   ├── service/order-status.service.ts        # status machine + transition broadcasts
    │   │   ├── repository/order.repo.ts               # applyScope(); writes address (id, created_at)
    │   │   ├── repository/order-item.repo.ts
    │   │   ├── entity/order.entity.ts
    │   │   ├── entity/order-item.entity.ts
    │   │   ├── dto/order.request.dto.ts
    │   │   ├── dto/order.response.dto.ts              # order + item DTOs in one file
    │   │   ├── constants.ts
    │   │   ├── types.ts                               # OrderScope, placement inputs
    │   │   ├── enums.ts
    │   │   ├── errors.ts
    │   │   └── routes.ts
    │   │
    │   ├── payment/
    │   │   ├── controller/payment.controller.ts
    │   │   ├── controller/webhook.controller.ts       # /payments/webhook/:provider (no auth)
    │   │   ├── service/payment.service.ts
    │   │   ├── service/payment-webhook.service.ts     # provider-neutral name: Kashier is behind IPaymentProvider
    │   │   ├── repository/payment-session.repo.ts
    │   │   ├── repository/transaction.repo.ts         # createTransactionIfNew (ON CONFLICT DO NOTHING)
    │   │   ├── repository/payment-webhook-event.repo.ts
    │   │   ├── repository/payment-provider.repo.ts
    │   │   ├── entity/payment-session.entity.ts
    │   │   ├── entity/transaction.entity.ts
    │   │   ├── entity/payment-provider.entity.ts
    │   │   ├── dto/payment.request.dto.ts
    │   │   ├── dto/payment.response.dto.ts            # payment + transaction DTOs in one file
    │   │   ├── merchant-ref.ts                        # <region>_<publicId>_<attempt> encode/decode
    │   │   ├── types.ts
    │   │   ├── enums.ts
    │   │   ├── errors.ts
    │   │   └── routes.ts
    │   │
    │   ├── delivery/                                  # no entity, no repo: the delivery IS the order
    │   │   ├── controller/delivery.controller.ts      # claim / unclaim / admin assign / agent transitions
    │   │   ├── service/delivery.service.ts            # agent transitions + settlement
    │   │   ├── service/assignment.service.ts          # candidate scan, offer round, claim arbitration
    │   │   ├── dto/delivery.request.dto.ts
    │   │   ├── dto/delivery.response.dto.ts           # DeliveryTaskResponseDTO, DeliverySummaryResponseDTO
    │   │   ├── types.ts
    │   │   ├── enums.ts
    │   │   ├── errors.ts
    │   │   └── routes.ts
    │   │
    │   │   # Reads and writes `orders` through OrderService — never its own
    │   │   # repository, and never another module's repo directly (CLAUDE.md §3).
    │   │   # Presence is reached through PresenceService; there is no presence
    │   │   # table to reach at all (see pkg/presence/).
    │   │
    │   ├── agent/
    │   │   ├── controller/agent.controller.ts         # presence online/ping/offline, tasks, earnings
    │   │   ├── service/agent.service.ts               # recordPosition, task list, earning settlement
    │   │   ├── service/presence.service.ts            # thin app-side wrapper over IPresenceStore
    │   │   ├── repository/agent-earning.repo.ts
    │   │   ├── entity/agent-earning.entity.ts
    │   │   ├── dto/agent.request.dto.ts               # PresenceRequestDTO (lat/lng, bounds-checked)
    │   │   ├── dto/agent.response.dto.ts
    │   │   ├── types.ts                               # ActiveOrderRef, task shapes
    │   │   └── routes.ts
    │   │
    │   │   # No presence repository or entity, and no earning.service.ts:
    │   │   # presence has no durable copy (§3.8) and settlement is one method
    │   │   # on AgentService, not a service of its own. No enums.ts/errors.ts —
    │   │   # the agent surface borrows the order status machine and its errors.
    │   │
    │   └── finance/                                   # restaurant balance; no HTTP surface yet
    │       ├── service/finance.service.ts             # credit on delivered, debit on refund
    │       ├── repository/restaurant-balance.repo.ts
    │       └── entity/restaurant-balance.entity.ts
    │
    │       # Called by delivery settlement and the payment webhook, never by a
    │       # route: the payout/statement endpoints are a later milestone, so
    │       # there is deliberately no controller, DTO or routes.ts yet.
    │
    ├── lib/                          # app-aware glue
    │   ├── auth/
    │   │   ├── guard.ts             # authenticate (JWT cookie), requireRole, requireInternalApiKey
    │   │   ├── rbac.ts              # rbac(), requireRestaurantMember, requireBranchAccess
    │   │   ├── roles.ts             # SystemRole
    │   │   ├── jwt.ts               # verifyAccessToken (same secret as core)
    │   │   └── errors.ts
    │   ├── cache/
    │   │   ├── init.ts
    │   │   └── withCache.ts
    │   ├── config/
    │   │   └── env.ts               # zod-validated: regions, Kashier, WS, dispatch radii, presence TTL
    │   ├── correlation/
    │   │   └── correlationId.ts
    │   ├── core-client/             # sync HTTP client to core-service
    │   │   ├── core-client.ts       # base fetch wrapper: retry, correlation, x-api-key, errors
    │   │   ├── branch.client.ts     # branch projection (core:branch:<id>, 60s) — carries lat/lng
    │   │   ├── product.client.ts    # per branch+product projection; MGET reads, pipelined writes
    │   │   ├── rbac.client.ts       # role → permissions projection (TTL only)
    │   │   ├── address.client.ts    # never cached: a stale address delivers to the wrong place
    │   │   ├── user.client.ts
    │   │   ├── projection.service.ts # the patch-don't-drop rules for inbound events
    │   │   ├── cache-keys.ts        # core:* keys, deliberately NOT region-prefixed
    │   │   ├── types.ts
    │   │   └── errors.ts
    │   ├── core-events/             # inbound async from core-service (RabbitMQ)
    │   │   ├── consumer.ts          # topology, prefetch, Redis SETNX dedupe, dispatch, manual ack/nack
    │   │   ├── registry.ts          # routing key → handler
    │   │   ├── event-types.ts
    │   │   ├── types.ts
    │   │   └── handlers/            # one file per ENTITY, matching what core actually publishes
    │   │       ├── index.ts         # registration
    │   │       ├── payload.ts       # typed payload parsing (no coercion — Boolean("false") is true)
    │   │       ├── product.handler.ts      # core.product.invalidated
    │   │       ├── branch.handler.ts       # core.branch.invalidated
    │   │       ├── restaurant.handler.ts   # core.restaurant.invalidated
    │   │       └── identity.handler.ts     # core.address/user.invalidated — registered no-ops
    │   │
    │   │   # NOT one file per fine-grained event. There is no
    │   │   # product-stock-changed / branch-deactivated / rbac-permissions-changed
    │   │   # handler, because core emits no such routing keys (CLAUDE.md §8).
    │   ├── messaging/
    │   │   └── init.ts              # single AMQP connection; topology declared by the consumer
    │   ├── di/
    │   │   ├── container.ts
    │   │   └── tokens.ts
    │   ├── error/
    │   │   ├── AppError.ts
    │   │   └── errorHandler.ts
    │   ├── http/
    │   │   ├── response.ts          # sendSuccess, sendPaginated
    │   │   └── pagination/
    │   │       ├── cursor-pagination.ts
    │   │       └── parse-query.ts
    │   ├── idempotency/
    │   │   ├── idempotency.ts       # middleware (Redis + DB fallback)
    │   │   └── idempotency-store.ts # the DB-backed durable store
    │   ├── jobs/                    # background workers, all started from server.ts
    │   │   ├── partition-maintenance.ts # pre-creates the next three monthly `orders` partitions
    │   │   ├── payment-expiry.ts        # releases stock held by unpaid `pending_payment` orders
    │   │   ├── assignment-sweep.ts      # re-offers orders no agent claimed; escalates the radius
    │   │   ├── presence-sweep.ts        # ZSCAN reap of geo entries whose liveness lapsed
    │   │   └── archival.worker.ts       # PHASE 5 — year-old rows to the archive cluster
    │   ├── knex/
    │   │   ├── knex.ts              # db(region) → Knex (hot); dbArchive(region) in Phase 5
    │   │   ├── knexfile.ts          # base config; per-region resolved at runtime
    │   │   ├── shards.ts            # region → connection config
    │   │   └── migration-region.ts  # the region a migration run is targeting
    │   ├── logger/
    │   │   └── logger.ts
    │   ├── sharding/                # region resolver
    │   │   ├── region-resolver.ts   # ?region= / X-Region / cookie; requireRegion; "all" for fan-out reads
    │   │   ├── regions.ts           # canonical list + helpers
    │   │   └── errors.ts
    │   ├── types/
    │   │   └── express.d.ts         # extends Request: user, correlationId, region
    │   ├── utils/
    │   │   └── cookie.ts
    │   ├── validation/
    │   │   └── validate.ts
    │   └── websocket/               # socket.io + @socket.io/redis-adapter
    │       ├── ws-server.ts         # attach to http.Server; Redis adapter + auth middleware
    │       ├── ws-auth.ts           # JWT verify + permitted-channel (room) derivation
    │       ├── publisher.ts         # what services call after a transition commits
    │       └── errors.ts
    │
    ├── pkg/                          # framework-agnostic, app-agnostic
    │   ├── cache/
    │   │   ├── cache.interface.ts    # get/set, getMany/setMany (MGET + pipeline), delByPattern (SCAN)
    │   │   └── redis.ts
    │   ├── messaging/                # broker interface + RabbitMQ client
    │   │   ├── message-broker.interface.ts
    │   │   └── rabbitmq/
    │   │       ├── rabbitmq.client.ts
    │   │       └── rabbitmq.types.ts
    │   ├── payments/                 # provider interface + Kashier client
    │   │   ├── payment.interface.ts  # IPaymentProvider: createSession, refund, verifyWebhook
    │   │   └── kashier/
    │   │       ├── kashier.client.ts
    │   │       ├── kashier.types.ts
    │   │       └── kashier.signature.ts # HMAC over data.signatureKeys, keyed with the Payment API Key
    │   ├── presence/                 # live location + spatial query for a fleet
    │   │   ├── presence.interface.ts # IPresenceStore: touch, remove, read, setActivity, findNearest, reapStale
    │   │   └── redis-presence.store.ts # GEOADD + GEOSEARCH; per-member HASH carries the liveness TTL
    │   └── utils/
    │       ├── time.ts
    │       ├── uuid.ts               # UUIDv7 mint + timestamp extraction (partition pruning)
    │       ├── money.ts              # minor-unit helpers
    │       ├── geo.ts                # haversine — prices an earning at settlement, NOT the dispatch search
    │       └── retry.ts
    │
    └── migrations/                   # knex migrations (raw SQL inside `up`/`down`)
        ├── 20260418000010_create_payment_providers.ts
        ├── 20260418000020_create_orders.ts            # RANGE-partitioned by created_at
        ├── 20260418000030_create_order_items.ts
        ├── 20260418000040_create_payment_sessions.ts
        ├── 20260418000050_create_transactions.ts
        ├── 20260418000060_create_restaurant_balances.ts
        ├── 20260418000090_create_agent_earnings.ts
        ├── 20260418000100_create_idempotency_keys.ts
        ├── 20260418000110_create_payment_webhook_events.ts
        └── 20260418000120_remove_cod_and_non_eg_providers.ts

        # ...070 (`deliveries`) and ...080 (`agent_presence`) are deliberately
        # unused: both tables were dropped from the design. The timestamps are
        # never reused, so a shard that already migrated keeps its ledger
        # (docs/database-design.md §3.7, §3.8).
        # (no core_inbound_events migration — dedupe is Redis SETNX)
```

---

## Layer rules (enforced by reading)

```
       app/  ── may import lib, pkg
       lib/  ── may import pkg, env; may NOT import app/<module>/* (except via DI tokens at boot)
       pkg/  ── pure providers, NO imports from lib or app, NO env, NO global singletons
```

### What goes in `pkg/`

- **Provider implementations** that could be swapped (Redis, Kashier, future Stripe).
- **Pure utilities** with no Express, no env, no DI dependency.
- A `pkg/` file should be unit-testable with **only** its inputs.

Examples in this service:
- `pkg/cache/redis.ts` — Redis client wrapper.
- `pkg/payments/kashier/kashier.client.ts` — raw Kashier HTTP client.
- `pkg/presence/redis-presence.store.ts` — live positions and the spatial query over them. It knows about ids, coordinates and an opaque "activity" string; it has never heard of agents, orders or regions (the caller passes a namespace, and `lib/` supplies the Redis client and the TTL from env).
- `pkg/utils/money.ts` — minor-unit helpers.
- `pkg/utils/geo.ts` — haversine, for pricing an earning at settlement. Note that the *dispatch* search is not here: proximity is answered by Redis `GEOSEARCH` inside the presence store, never by a distance computed in application code and never by a SQL query.

### What goes in `lib/`

- **App glue**: middleware, DI container, env-driven config, Express extensions, shared service infra (idempotency, WS server, AMQP consumer loop for inbound core events).
- May import `pkg/` and `lib/config/env`, but never `app/<module>/*` directly. The DI container is the single allowed exception (`lib/di/container.ts` registers concrete classes from `app/`).

Examples:
- `lib/idempotency/idempotency.ts` — middleware that pulls the cache provider from DI.
- `app/agent/jobs.ts` — periodic reap of stale geo entries. The *rule* for staleness is not here and not in any service: it is the TTL on the presence store's per-member key, so nothing compares a timestamp to decide who is live.
- `lib/jobs/archival.worker.ts` — Phase 5: nightly job that copies year-old rows to the archive cluster, then deletes from hot.
- `lib/sharding/region-resolver.ts` — Express middleware mapping requests to a region. The region is also the presence namespace, which is why an agent in `eg` is invisible to a branch in `sa` with no filtering in application code.
- `lib/websocket/ws-server.ts` — WS server attached to the HTTP server.

### What goes in `app/<module>/`

- Business logic, state machines, RBAC enforcement choices, error definitions, request/response DTOs.
- One module per bounded context. Cross-module calls go through services (never another module's repository).

---

## Per-module file conventions

Same as core-service. Recap:

| File                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `controller/<m>.controller.ts`        | `@injectable()`. Validates body via `validateBody`, calls service, maps to **Response DTO**, calls `sendSuccess`/`sendPaginated`. |
| `service/<m>.service.ts`              | `@injectable()`. Orchestrates repos and other services. Throws `AppError`. |
| `repository/<m>.repo.ts`              | Exported **functions** (not classes). Each takes optional `conn: Knex`. Has `<MODULE>_COLUMNS` const + `toEntity(row)`. |
| `entity/<m>.entity.ts`                | Plain class. Constructor takes `Partial<Entity>`. No DB knowledge. |
| `dto/<m>.request.dto.ts`              | class-validator-decorated request shapes. |
| `dto/<m>.response.dto.ts`             | Response payload shape. Static `from(entity, ...)` factory. **Money in minor units; ts in ISO 8601.** |
| `enums.ts`                            | string enums whose values match DB CHECK constraint values. |
| `errors.ts`                           | Exported `AppError` instances (not classes). |
| `routes.ts`                           | Resolves the controller from DI; wires middleware. |

---

## Comparison to core-service

| Concept                        | core-service       | order-service                                  |
| ------------------------------ | ------------------ | ---------------------------------------------- |
| `app/` modules                 | yes                | yes (same shape)                               |
| `lib/` glue                    | yes                | yes + `core-client/`, `core-events/`, `messaging/`, `sharding/`, `websocket/`, `jobs/` |
| `pkg/` agnostic providers      | yes (`cache`, `email`, `utils`) | yes (`cache`, `messaging`, `payments`, `presence`, `utils`) |
| `migrations/`                  | yes                | yes                                            |
| `dto/` files                   | request only       | **request + response**                         |
| `db` export                    | singleton          | **`db(region)` function** (+ `dbArchive(region)` in Phase 5) |
| WebSocket                      | no                 | yes (`lib/websocket/`, scaffold in Phase 0)    |
| Sharding (per country)         | no                 | yes (`lib/sharding/`)                          |
| Async to other services        | no                 | **inbound only** via RabbitMQ (`lib/core-events/`); no outbound |
| Cross-service HTTP client      | no                 | yes (`lib/core-client/`, base in Phase 0)      |
| Read replicas                  | no                 | no (deferred)                                  |
| Agent presence / proximity     | n/a                | Redis only (`pkg/presence/`, `GEO` + a TTL'd member key). **No table, no PostGIS, no spatial column** — losing it all is a supported state (`docs/database-design.md` §3.8) |

# CLAUDE.md — Order & Payments Service Guidelines

These rules apply to the **`order-service`** microservice of the **QuickBite** platform. They mirror the conventions of `core-service` while adding constraints specific to this service (DTO responses, region-sharded Postgres, Redis caching, sync/async I/O with `core-service`, WebSocket live updates, Kashier v3 payment integration).

When in doubt, look at how `core-service` does it and follow that exact pattern. Deviate **only** where a deviation is documented here.

---

## 1. Mission of this service

This service owns the **transactional truth** of the platform:

- **Orders** — placement, lifecycle, history, restaurant operations.
- **Payments** — online (Kashier v3) and Cash on Delivery (COD), webhooks, refunds.
- **Deliveries** — assignment, agent presence, lifecycle, earnings.
- **Restaurant finance** — running balance and payouts (modeled as transactions).
- **Real-time updates** — WebSocket broadcast of order/delivery status changes.

It does **not** own: users, restaurants, branches, products, RBAC permission catalog. Those live in `core-service` and are consumed sync (HTTP) or via cached projections.

---

## 2. Tech stack (locked — do not deviate)

| Concern              | Library / Tool                                   |
| -------------------- | ------------------------------------------------ |
| Runtime              | Node.js + TypeScript (strict, decorators on)     |
| HTTP framework       | `express` v5                                     |
| Validation           | `class-validator` + `class-transformer`          |
| DI                   | `tsyringe` (singletons via `TOKENS` symbols)     |
| Env validation       | `zod`                                            |
| DB driver            | `knex` over `pg`                                 |
| Cache                | `ioredis` via `RedisCacheProvider`               |
| Auth                 | `jsonwebtoken` (access in cookie; same JWT shape as core) |
| Password hashing     | `bcrypt`                                         |
| Email                | `node-mailjet` (only if needed — most notifications are WS) |
| WebSocket            | `socket.io` + `@socket.io/redis-adapter` for cross-worker fan-out |
| Messaging            | **RabbitMQ** via `amqplib` (core → order async)  |
| Logging              | Custom `Logger` (matches core)                   |
| IDs                  | `uuid` v4 for client-facing order ids; bigserial for internal |
| Payments             | Kashier v3 (Payment Sessions + Webhooks)         |

**Do not introduce new libraries** without justification. ORMs (TypeORM, Prisma, etc.) are **forbidden** — Knex query builder + raw SQL only, exactly like `core-service`.

---

## 3. Folder structure (mirrors `core-service`)

```
src/
  app.ts                    # express app composition
  server.ts                 # bootstrap + graceful shutdown
  routes.ts                 # mounts all module routers under /api
  app/                      # business modules (one folder per bounded context)
    <module>/
      controller/<module>.controller.ts
      service/<module>.service.ts
      repository/<module>.repo.ts
      entity/<module>.entity.ts
      dto/
        <module>.request.dto.ts     # request bodies (class-validator)
        <module>.response.dto.ts    # response payloads (see §6)
      enums.ts
      errors.ts
      routes.ts
  lib/                       # app-aware glue: depends on app/, env, di
    auth/             # guard.ts, rbac.ts, errors.ts, jwt utils
    cache/            # init.ts, withCache.ts
    config/           # env.ts (zod-parsed)
    correlation/      # correlationId middleware
    di/               # container.ts, tokens.ts
    error/            # AppError.ts, errorHandler.ts
    http/             # response.ts, pagination/
    idempotency/      # idempotency middleware
    knex/             # knex.ts, knexfile.ts (sharded — see §8)
    logger/           # logger.ts
    types/            # express.d.ts (req.user, req.correlationId)
    validation/       # validate.ts (validateBody)
    websocket/        # ws server, hub, channel auth — NEW vs core (scaffolded in Phase 0)
    sharding/         # shard router by country — NEW vs core
    core-client/      # sync HTTP client to core-service — NEW vs core (scaffolded in Phase 0)
    core-events/      # inbound async consumer (RabbitMQ): cache invalidation handlers — NEW vs core
    messaging/        # AMQP connection, channel lifecycle, DI registration — NEW vs core
    jobs/             # background workers (only the cold archival worker in this milestone)
  pkg/                      # reusable, app-agnostic, framework-free
    cache/       # cache.interface.ts, redis.ts
    messaging/   # IMessageBroker interface, amqplib-based RabbitMQ client (no app types)
    payments/    # IPaymentProvider interface, kashier client (no app types)
    utils/       # time.ts, money.ts, retry.ts
  migrations/               # knex migrations, snake_case table/column names
```

### `pkg/` vs `lib/` vs `app/` — strict layering

```
       app/  ── may import lib, pkg
       lib/  ── may import pkg, env; may NOT import app/<module>/* (except via DI tokens at boot)
       pkg/  ── pure providers, NO imports from lib or app, NO env, NO global singletons
```

- `pkg/` is **framework-agnostic** and **app-agnostic**. It exports interfaces and concrete providers (Redis client, Kashier HTTP client, money helpers). It must remain swappable and unit-testable in isolation.
- `lib/` wires `pkg/` to the app: knex config from env, redis init, DI container, middleware. It knows about Express and the env, but should not contain business rules.
- `app/` contains business modules. Cross-module calls must go through services (never reach into another module's repository).

If you find yourself importing `app/...` inside `pkg/` or `lib/`, **stop and refactor**. The DI container is the only place `lib/` may reference `app/` (to register classes at boot — `container.ts`).

---

## 4. Naming conventions

### Files
- `kebab-case` for filenames: `order-status.service.ts`.
- One class per file; file name matches the class' kebab-case form.

### TypeScript
- `PascalCase` classes/types/enums.
- `camelCase` variables/methods.
- `UPPER_SNAKE` constants and DI token symbol names.

### Database (Postgres)
- Tables: plural, `snake_case` (`orders`, `order_items`, `restaurant_balances`).
- Columns: `snake_case`. Boolean prefixed with `is_`.
- Primary keys: `id BIGSERIAL` (use `BIGINT` for FK columns).
- Foreign key constraints: `fk_<child_table>_<column>` → e.g. `fk_orders_customer_id`.
- Indexes: `idx_<table>_<col>[_<col>...]` for btree; `idx_<table>_<col>_gist` for GIST.
- Unique constraints: `uq_<table>_<col>[_<col>...]`.
- Check constraints inline; enum-like columns use `TEXT NOT NULL CHECK(col IN (...))` to match the core-service pattern (avoid native PG enums except for currency, which already exists).
- Timestamps: `created_at`, `updated_at`, `<verb>_at` (e.g. `accepted_at`, `picked_at`, `delivered_at`). All `TIMESTAMP NOT NULL` unless modelling absence (use `TIMESTAMP NULL`).
- Money: `INT` storing minor units (cents/piasters). **Never `DECIMAL` for money on hot paths.** This deviates from the draft schema in `img_2.png` — see §7.

### Routes
- Plural resource nouns: `/orders`, `/payments`, `/deliveries`, `/agents`.
- Sub-routes for relations: `/restaurants/:restaurantId/orders`.
- `PATCH` for partial updates (single status endpoint per resource).

---

## 5. Module file conventions

Every module under `app/<module>/` follows the same skeleton (see `core-service/src/app/restaurant/` for the canonical example):

1. **`entity/<module>.entity.ts`** — plain class, constructor takes `Partial<Entity>`. No decorators. No DB knowledge. No methods beyond simple invariants (e.g. `isExpired()` like `password-reset.entity.ts`).
2. **`dto/*.request.dto.ts`** — class-validator-decorated request shapes. Validated by `validateBody(DTO, req.body)` in the controller.
3. **`dto/*.response.dto.ts`** — **NEW for this service.** See §6.
4. **`repository/<module>.repo.ts`** — exported functions (not classes). Each function takes optional `conn: Knex = db` to allow trx composition. Uses a `<MODULE>_COLUMNS` const and a private `toEntity(row)`.
5. **`service/<module>.service.ts`** — `@injectable()` class registered in `lib/di/container.ts`. Holds business logic. Composes repositories and other services. Throws `AppError`.
6. **`controller/<module>.controller.ts`** — `@injectable()`. Methods are arrow-function properties (preserves `this` when passed to express). Validates body, calls service, maps to **response DTO**, then `sendSuccess`/`sendPaginated`.
7. **`routes.ts`** — wires middleware (`authenticate`, `rbac`, `requireRestaurantMember`, `requireBranchAccess`, `idempotency`, `withCache`) to controller methods. Resolves controller from DI container at module load.
8. **`enums.ts`** — string-valued enums; values match DB CHECK constraints.
9. **`errors.ts`** — exported `AppError` instances (not classes). Stable wording, stable status codes.
10. **`types.ts`** — module-level **non-entity** type aliases and helper interfaces shared between service / controller / repo (e.g. `BranchProductRow`, `ReserveStockInput`, response shapes that don't warrant a class). Keep services, controllers, and repos free of inline `interface X { ... }` declarations.

---

## 6. Response DTOs — the rule that differs from core

In `core-service`, services and controllers often return raw entities or ad-hoc objects. **In this service, every HTTP response payload MUST be shaped by a Response DTO class** declared in `dto/*.response.dto.ts`.

Reasons:
1. Decouples the wire format from internal entities/DB columns.
2. Lets us evolve schemas without leaking column changes to clients.
3. Keeps OpenAPI/contract docs honest — response DTOs are the single source of truth.
4. Avoids accidentally leaking sensitive columns (provider reference IDs, internal balances).

### Rules

- Response DTOs live in `dto/<module>.response.dto.ts` (one file may contain multiple DTOs).
- They are **plain classes**, not class-validator (validation runs on the way in, not out). They may use `class-transformer` `@Expose`/`@Exclude` if needed but the simpler pattern is a static `from(entity, ...)` factory:

  ```ts
  export class OrderResponseDTO {
      id!: string;
      status!: OrderStatus;
      subtotal!: number;
      deliveryFee!: number;
      currency!: Currency;
      createdAt!: string; // ISO
      items!: OrderItemResponseDTO[];

      static from(order: OrderEntity, items: OrderItemEntity[]): OrderResponseDTO {
          const dto = new OrderResponseDTO();
          dto.id = order.publicId;
          dto.status = order.status;
          // ... map only the fields you want exposed
          dto.items = items.map(OrderItemResponseDTO.from);
          return dto;
      }
  }
  ```

- Controllers must **always** return DTOs (or arrays of DTOs) inside `sendSuccess`/`sendPaginated`. Never pass a raw entity to `sendSuccess`.
- Money fields in response DTOs are returned as **integer minor units** (e.g. `1500` for 15.00 EGP), with a `currency` field next to them. Do not pre-format or localize on the server.
- Timestamps in responses are **ISO 8601 strings in UTC** (`Date.toISOString()`).
- Never include `internal*`, `*_hash`, provider secrets, or internal numeric IDs that are not part of the public contract. The public order id is a **UUID** (`public_id`), not the bigserial PK.

---

## 7. Database design rules (full schema in `docs/database-design.md`)

### Money

- Stored as `INT` minor units. Currency held on the row (or derivable from the order's branch).
- The draft in `img_2.png` shows `decimal` for `subtotal`, `delivery_fee`, etc. **We replace this with `INT` minor units** because:
  - Decimal arithmetic in Knex returns strings → easy to mishandle.
  - Money math in JS over decimal strings is error-prone; integer math is exact.
  - Aggregation across millions of rows is faster.
- Display formatting is the client's job.

### Sharding

- Shard key: **country** (`eg`, `sa`, ...). One Postgres cluster per country.
- The shard key is referred to in code as `region` — it just happens to be a country code today. We keep the column named `region` so the router stays generic if we ever sub-shard a country later.
- Every sharded table includes `region TEXT NOT NULL` immediately after `id`.
- Cross-shard queries are **forbidden** in the hot path. Customer/restaurant/agent reads always include the region in the route or JWT claim so the shard router can pick the correct connection.
- See `docs/system-design.md` §Sharding and `lib/sharding/` for the router.

### Indexing

- Indexes are added **only to support a query that exists in code**. No speculative indexes.
- Each index in a migration must have a one-line comment naming the query path it supports (e.g. `-- supports GET /restaurant/orders?branchId=&status=`).
- Composite indexes follow the **(equality cols, then range col)** rule — e.g. `(branch_id, status, created_at DESC)` for the restaurant orders list.
- **No `N+1` queries.** When a service needs related rows, the repository must `JOIN` or batch-fetch with `whereIn`. If a controller maps over an array and calls a per-row repository function, that is a bug — fix it in the repository.
- For order lists with items, fetch orders first, then a single `whereIn('order_id', orderIds)` for items, then assemble in the service.

### Foreign keys

- **Every** FK gets a named constraint and a supporting index (Postgres does **not** auto-index FKs). Pattern: `fk_<table>_<col>` constraint + `idx_<table>_<col>` index.
- Cross-service FKs (e.g. to `users.id` in `core-service`) are **logical only** — there is no DB-level FK because the data lives in another database. We document the reference in the migration as a comment and rely on application-level checks plus the `core-client`.

### Soft delete

- Most order/payment data is **append-only** (audit trail). Use status transitions, not deletes. Where soft delete is needed, use `deleted_at TIMESTAMP NULL` and partial index `WHERE deleted_at IS NULL`.

### Partitioning

`orders` is **RANGE-partitioned by `created_at`**, one partition per month, declaratively — not with `pg_partman` (no Postgres 18 Windows build, and a rolling month window is a dozen lines of SQL). `lib/jobs/partition-maintenance.ts` pre-creates the next three months at boot and daily after; a DEFAULT partition catches anything that slips through and is expected to stay empty.

Four consequences that constrain every migration and query touching `orders`:

1. **Every unique constraint must contain the partition key.** The PK is `(id, created_at)` and `public_id` is unique per `(public_id, created_at)`. Global uniqueness of `public_id` is an *application* guarantee — it is a UUIDv7, so a collision needs a 74-bit random collision inside the same millisecond.
2. **Reads should carry a `created_at` bound.** Postgres has no global index across partitions, so an unbounded lookup fans out across every month. `public_id` is a UUIDv7 and its embedded timestamp is what `findOrderByPublicId` uses to derive a window and prune to one partition.
3. **No child table can FK to `orders`** unless it carries `created_at` too. `order_items.order_id` is a logical reference; header and lines are written in the same service transaction.
4. **Writes must address `(id, created_at)`.** `updateOrderStatus` has `created_at` in its predicate both to satisfy the PK and to prune to the row's partition.

`order_items` is deliberately **not** partitioned — it is only ever read by `order_id`, and a plain btree beats partition fan-out there.

Swapping in `pg_partman` later means replacing the maintenance job with `create_parent()` + `run_maintenance_proc()`; none of the above changes.

### Archival

- Per the PRD, only the **current year**'s orders/payments are queryable from the hot DB. Older rows are moved to a **separate cold Postgres database per region** (`order_service_archive` cluster, one per region — same shard topology as the hot DB). The archival worker is implemented in this milestone — see `docs/implementation-plan.md` Phase 7.

---

## 8. Cross-cutting infra

### Knex / sharding

`lib/knex/knex.ts` exports `db()` as a **function** (not a singleton), taking a region key:

```ts
const conn = db(region); // returns the Knex instance for that shard
```

The default export `defaultDb` exists only for migrations and shared (non-sharded) tables — there should be very few of these.

### Idempotency

- **Required** on all order-creating, payment-initiating, and assignment endpoints.
- Use `idempotency({strict: true})` middleware (see `core-service/src/lib/idempotency/idempotency.ts`).
- Idempotency keys are stored in Redis with a 24h TTL and **also** persisted in an `idempotency_keys` table for the critical write paths (`POST /orders`, `POST /payments/init`) so we survive Redis loss.

### Cache

- Read-heavy endpoints use `withCache(ttl, userScoped)`.
- Cache invalidation: explicit `cacheProvider.del(key)` calls in the service after mutating writes. Do **not** rely on TTL alone for user-facing data.
- Per-region cache namespacing: keys must be prefixed with the region (`eg:order:123`). Projections of core's data are the exception and are deliberately **not** region-prefixed — see `lib/core-client/cache-keys.ts`.
- **Each service has its own Redis in production.** Nothing may assume a key written by core is visible here, or vice versa. The `core:*` keys in this service are *our* projections of core's data, not a shared cache; core's own caches live under its own prefixes in its own instance.
- **Hot upstream reads are cached on both sides of the call.** `GET /api/internal/branches/:id` is read on every single placement, so it is cached here (`core:branch:<id>`, 60s) *and* in core's `InternalService.getBranch` (300s, invalidated explicitly by its branch and restaurant writers). The two are independent; neither is load-bearing for correctness.
- What to cache is a question about read rate, not about convenience: the branch projection, the product projections and the role-permission projection are hot (every placement, every restaurant request). A customer address is **not** — a customer places one or two orders a day, a cached address buys nothing, and a stale one means delivering to the wrong place. Read it through every time.
- **A per-key cache must still be one round trip.** The product projection is keyed per branch+product, because that is the granularity core's invalidation events arrive at and the granularity two overlapping baskets share. N sequential `get`s would pay N network latencies and hand that win straight back, so batch reads go through `getMany` (MGET) and batch writes through `setMany` (pipeline). A per-key cache read in a loop is a bug, the same way an N+1 query is.

### Auth

- Same JWT contract as `core-service` (`req.user.userId`, `role`, `restaurantId?`, `restaurantRole?`, `branchIds?`).
- Region is **not** in the JWT. It comes from `?region=` / `X-Region` header / `region` cookie (precedence in that order). `"all"` is preserved so specific read endpoints can fan out; writes resolve to one concrete region.

### Internal service-to-service auth

- Shared-secret header `x-api-key`, in both directions. Guard for **inbound** calls is `requireInternalApiKey` in `lib/auth/api-key.ts` — plain equality against `env.internal.apiKey`.
- **Outbound** to core is not symmetric: core's `lib/auth/api-key.guard.ts` SHA-hashes the header value and looks it up in its `api_keys` table (row seeded from core's `ORDER_SERVICE_API_KEY` by migration `20260927100300`), then applies `rbac()` against the `order_service` role. So `CORE_INTERNAL_API_KEY` here must equal core's `ORDER_SERVICE_API_KEY` verbatim, and that migration must have run on the core DB.
- Do **not** invent parallel `internal/` modules. Each domain module owns its own internal routes inline in its `routes.ts`, prefixed `/internal/...` and guarded by `requireInternalApiKey`.
- Service and repository method names must be caller-agnostic — **never** `findForInternal`, `getByIdInternal`, `reserveStockForInternal`. A `findById` is a `findById` regardless of who calls it. The route path or at most a controller method name may signal "internal"; underlying services/repos stay generic and reusable.

### RBAC

- This service does **not** maintain its own permissions catalog. It uses the same `rbac()` middleware logic as core, but resolves permissions from a **read-through cache** populated from `core-service` (see `lib/core-client/`).
- Permissions used in this service are namespaced `orders:*`, `payments:*`, `deliveries:*`. The seed for these lives in `core-service/src/migrations/` and is documented in `docs/business-logic/rbac.md`.

### Error handling

- Throw `AppError(message, statusCode)` from services. Never throw plain `Error`.
- Module-level error instances live in `errors.ts` for the canonical, user-facing messages. Don't construct ad-hoc `AppError`s in services for cases that have a stable name.

### Transactions

- Use the explicit try/commit/catch/rollback pattern (match `auth.service.ts`):
  ```ts
  const trx = await db.transaction();
  try {
      await someRepo(..., trx);
      await anotherRepo(..., trx);
      await trx.commit();
      return result;
  } catch (err) {
      await trx.rollback();
      throw err;
  }
  ```
- Do **not** use `db.transaction(async (trx) => {...})` callback form — it is inconsistent with the rest of the codebase.
- The service owns the trx and passes it to every repo call in the unit of work. Repos never start their own trx (their `conn: Knex = db` parameter is how the trx flows in).

### Validation

- All request bodies pass through `validateBody(RequestDTO, req.body)`. Path/query params are validated inline in the controller (`Number(req.params.id)`, `parsePaginationQuery`, `parseFilters`).

### Async with `core-service` (RabbitMQ)

This service does **not** emit outbound async events to anyone in this milestone. The only async path is **inbound from `core-service` over RabbitMQ** for cache invalidation and authorization invalidation.

- Topology:
  - Topic exchange: `core.events` (durable, declared by core).
  - Consumer queue: `order-service.core-events` (durable, declared by this service).
  - Bindings: `core.#` (multi-word match — `*` matches one segment and would miss `core.branch.invalidated`).
  - DLQ: `order-service.core-events.dlq` for poison messages (routed via the queue's dead-letter-exchange).
- Events consumed (routing key = event type). This is **what core actually publishes** — its `lib/events/events.ts` emits one coarse event per entity type:
  - `core.product.invalidated` → patch `core:product:<branchId>:<id>` with the new `stock` / `unitPriceMinor` / `isAvailable` when the payload carries `branchId`; otherwise delete `core:product:*:<id>` (the event names no branch, so the product goes from every branch that cached it).
  - `core.branch.invalidated` → patch `core:branch:<id>` with the new trading flags and re-derive the reject-new-orders flag; delete the projection when the payload carries no flags.
  - `core.restaurant.invalidated` → delete `core:branch:*` (the restaurant's trading status reaches us only inside the branch projection) + the suspended flag. Nothing to patch: the event doesn't carry the status.
  - `core.address.invalidated`, `core.user.invalidated` → registered no-ops; neither is cached.

- **Do not** write handlers or bindings for `product.stock.changed`, `product.price.changed`, `branch.deactivated`, `restaurant.suspended` or `rbac.permissions_changed`. Earlier drafts of this file and `docs/implementation-plan.md` specified them, but core emits none of them, and `product.#`-style bindings match none of its routing keys — a service configured that way consumes nothing at all. What follows from that:
  - The reject-new-orders flag **is** event-driven, but off the enriched `core.branch.invalidated` payload rather than a distinct `branch.deactivated` event — see "Payload contract" below. A branch core has just closed therefore stops taking orders on the strength of the event itself, not when a TTL lapses.
  - The pending-order-review flag is **not**: nothing core publishes carries a restaurant's new status. Deleting the branch projection is enough for correctness — the next placement re-reads from core and sees a non-active restaurant status — it just costs one upstream call instead of a Redis hit.
  - The RBAC permission projection expires on its TTL alone.
  See `docs/implementation-plan.md` Phase 1 → "Deviations as built".
- Delivery semantics: **at-least-once**. Manual ack after the handler commits. Duplicates are expected.
- Dedupe via Redis SETNX on `core-events:dedupe:<eventId>` (24h TTL): set-if-absent before dispatching the handler; if not fresh, ack and skip. Safe to expire because every handler is idempotent — a patch applies the same committed values twice, a delete deletes nothing the second time.
- Authentication: AMQP credentials (per-service vhost user/pass from env). No HMAC on the wire — the broker is trusted.
- There is **no** outbound `events_outbox` in this service. If a future consumer requires it, add both the table and a dispatcher then.

### Payload contract: patch, don't drop

The payload floor is `{ id, occurredAt }`. On top of that, core sends the values
its writing transaction actually committed where it has them — the branch's
`isActive`/`acceptOrders`, a branch product's `branchId`/`stock`/`unitPriceMinor`/
`isAvailable` (its `buildBranchInvalidationPayload` / `buildProductInvalidationPayload`).
**Prefer correcting the projection in place over deleting it** whenever the
payload carries every field needed. Stock moves on every order placed anywhere,
so a delete-only handler flushes the product projection on exactly the event
that fires most; patching keeps the cache warm instead.

Three rules, all enforced in `lib/core-client/projection.service.ts`:

1. **A patch never creates a projection.** Merge into what is cached; if
   nothing is cached there is nothing to correct, and inventing a partial
   projection would serve fields core never sent.
2. **Only patch fields the event carries, and never coerce them.** Core strips
   undefined fields before persisting the payload, so a field's presence means
   core wrote that value. `Boolean("false")` is `true` — a coerced flag would
   cache a closed branch as open. A non-boolean flag falls back to a delete.
3. **Absent means unknown, not false.** A payload that mentions neither flag
   leaves the derived flags alone rather than guessing a branch back open.

Every path stays idempotent, which is what keeps at-least-once delivery and the
24h dedupe window safe.

### Handler structure

Handlers are **thin wrappers, exactly like controllers** (§10): parse the
payload into typed values, call one service method, nothing else. One file per
entity under `lib/core-events/handlers/`, payload parsing in
`handlers/payload.ts`, registration in `handlers/index.ts`, the registry in
`registry.ts`, and the transport (topology, dedupe, dispatch, ack/nack) in
`consumer.ts`.

Everything a handler *does* belongs in a service — today that is
`CoreProjectionService`, because every inbound event is a cache correction.
That is a property of this milestone, not of the design: a handler that needs a
database write, a second upstream call or a WebSocket broadcast delegates to
whichever service owns that domain (resolved from the DI container inside the
handler body, so registration never depends on boot order), and only
`handlers/index.ts` changes. Do **not** let a handler grow a body.

### Reliability requirement on `core-service`

Core must use a **transactional outbox** on its side: domain mutation and an outbox row are written in the same DB trx; a core-side dispatcher drains the outbox to RabbitMQ with publisher confirms. Publishing directly in the request path without an outbox can lose events on crash and is not acceptable.

### Payments (Kashier v3)

The provider lives behind `IPaymentProvider` in `pkg/payments/`. Nothing in
`app/payment/` names Kashier except the provider registration in
`container.ts`: a second acquirer is a second adapter, not a second service.

Four things about this integration are not guessable and have bitten earlier
drafts of this file:

- **There is no webhook secret.** The HMAC is keyed with the **Payment API
  Key** — the same credential that goes in the `api-key` header on session
  creation. `KASHIER_WEBHOOK_SECRET` does not exist. Neither does
  `KASHIER_FAIL_URL`: v3 has a boolean `failureRedirect`, and we send `false`.
- **The signature covers a projection, not the bytes.** `data.signatureKeys`
  names the signed fields; they are sorted, rendered `key=urlencode(value)`,
  joined with `&`, HMAC-SHA256'd. So `express.json()` is enough — there is no
  raw-body middleware to add — and **every field outside that list is
  unauthenticated**. Pinned to Kashier's published vector in
  `play/test-kashier-signature.ts`; change `kashier.signature.ts` and run it.
- **A webhook carries no session id and no region.** It names the payment by
  the `order` reference we chose, echoed back as the signed `merchantOrderId`.
  Hence `<region>_<publicId>_<attempt>`: the region because we must pick a
  shard before reading anything and `metaData` is unsigned, the public id
  because its UUIDv7 timestamp prunes the partition scan, the attempt because
  Kashier refuses to reuse a reference (`ERR_ORD_02`).
- **`event` is the operation, never the outcome.** A declined card arrives as
  `pay` with `data.status = "FAILURE"`. Branch on `data.status`.

Rules for anything that touches money here:

1. **Refuse, don't retry, when a retry cannot help.** The webhook answers 200
   with an empty body and a stamped `process_error` for a duplicate, an
   unrecognised reference, or an amount that doesn't match the session; it
   throws (500) only for genuine processing failures. A non-2xx buys the same
   event ten more times over a day.
2. **Every inbound event leaves a row** in `payment_webhook_events`, written
   before the money work and stamped `processed_at` or `process_error` after
   — on a separate connection when the transaction rolled back.
3. **The ledger's unique `idempotency_key` is the real guard.** Write through
   `createTransactionIfNew` (`ON CONFLICT DO NOTHING`), never a try/catch: a
   constraint violation inside a transaction aborts every statement after it.
4. **Never hold a transaction across a provider call.** The refund row is
   written `pending` first, outside any transaction, and the webhook settles
   it. A timeout leaves it `pending`, which is the truth.
5. **An online order holds reserved stock.** `lib/jobs/payment-expiry.ts` is
   what gives it back when nobody pays; anything that leaves an order in
   `pending_payment` must be reachable by that sweep.

### WebSocket

- One `ws` server per region-pinned process, mounted on the same HTTP server (`server.ts`). The server **scaffold** (server, hub, auth, publisher) lands in **Phase 0** so any module added later can publish without re-wiring infrastructure. Wiring of actual events into services happens in **Phase 6**.
- Channel naming: `customer:<userId>`, `restaurant:<restaurantId>`, `branch:<branchId>`, `agent:<agentId>`.
- Auth on connect: client passes the same access token (cookie or `?token=` query). The server verifies, then subscribes the socket to channels it is authorized for.
- Broadcasts are produced by services after a status transition commits, published via Redis Pub/Sub so all WS workers in the region receive it.

---

## 9. Performance & scale rules

This service is the **hot path**. The following are non-negotiable:

1. **No N+1 queries.** Repositories must batch.
2. **Every query must be backed by an index.** Run `EXPLAIN` mentally before merging.
3. **No SELECT \***. Always list columns via `<MODULE>_COLUMNS` (matches core).
4. **No app-side joins** of data that lives in the same DB. Use SQL joins.
5. **Long-running work** (PDF generation, bulk emails, archival) goes to a background worker, not a request handler.
6. **Cache** read-heavy endpoints (restaurant order list filtered to `pending`, agent task list, branch presence). TTL chosen per use case, documented in the route file.
7. **Idempotency** on every write endpoint that costs money or creates orders.
8. **Connection pool**: `DB_POOL_MAX` is per-shard. Default 10. Tune from benchmarks.
9. **Pagination is cursor-based**, never offset. Use `applyCursorPagination` (already in `lib/http/pagination/`).
10. **Hot writes** (order insert, payment status update) must complete in **< 200ms p95**.

---

## 10. Code style — what to avoid

- ❌ ORMs, decorators on entities, repository classes (we use functions).
- ❌ Returning entities from controllers (use response DTOs).
- ❌ Cross-module repository imports (use service of that module, or move shared logic to `lib/`).
- ❌ Business logic in controllers. Controllers do: validate → call service → DTO → respond.
- ❌ `try { ... } catch (e) { console.log }`. Always rethrow or convert to `AppError`.
- ❌ `any` in service signatures. DTOs and entities everywhere.
- ❌ Silent failures in webhooks. Webhook handlers must persist their result (success/failure) so retries are deterministic.
- ❌ Mutating the input body or DTO inside a service. Treat them as read-only.
- ❌ Creating new env vars without adding them to `lib/config/env.ts` zod schema.

---

## 11. When implementing a new module

Follow this exact order — never skip ahead:

1. Migration (table + indexes + FKs + comments naming the supporting query).
2. Entity class.
3. Request DTO(s).
4. Response DTO(s).
5. Repository functions.
6. Service class (register in `container.ts`).
7. Controller class (register in `container.ts`).
8. Module `routes.ts`.
9. Mount in `src/routes.ts`.
10. Smoke test the endpoint manually before moving on.

Implement one module end-to-end before starting the next. Order: **orders → payments → deliveries → agents → restaurant-finance → websocket integration → archival worker**. See `docs/implementation-plan.md`.

---

## 12. Reference docs (in `docs/`)

- `docs/database-design.md` — full schema, FK map, indexes, sharding plan.
- `docs/system-design.md` — region sharding, redis layers, sync/async flows, kashier, websocket, archival.
- `docs/folder-structure.md` — annotated tree, layer rules.
- `docs/api-contracts.md` — endpoint-by-endpoint request/response DTOs and error codes.
- `docs/business-logic/` — one file per module describing flows, invariants, RBAC, status machines.
- `docs/implementation-plan.md` — step-by-step build order with acceptance checks.

---

## 13. Out of scope (do not build)

- Analytics service / analytics DB and any async event emission to it (separate service, future).
- Outbound async events from this service to **any** consumer in this milestone — async with core-service is **inbound only** (cache invalidation).
- DevOps / deploy infra, observability stack, benchmark/perf testing — separate effort, future.
- Read replicas — single primary per region for now; revisit when traffic justifies it.
- Recommendations, loyalty, AI delivery optimization, reviews (PRD §13).
- Payouts as a separate table — payouts are modeled as a `transaction_type` in the `transactions` table.
- Incentives / promo codes (explicit user instruction).

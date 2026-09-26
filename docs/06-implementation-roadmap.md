# Implementation Roadmap

This is the build order for the whole service, and the per-module checklist to repeat for each
one. It formalizes core-service's own informal `src/workflow` checklist
(`Database migrations → Entities → repository queries → service functions → controllers → routes
→ mount → test, repeat`), made explicit and extended with the response-DTO step that's new here.

## 0. One-time project setup (before any module work)

- [ ] `package.json` scaffold matching `05-folder-structure.md` §7: express, knex, pg, ioredis,
      zod, jsonwebtoken, class-validator, class-transformer, tsyringe + reflect-metadata, helmet,
      cors, cookie-parser, dotenv — same dependency choices as core-service, current stable
      versions.
- [ ] **Configure eslint + prettier for real** (config files present, `lint`/`format` npm
      scripts wired) — core-service installed these but never configured them
      (`05-folder-structure.md` §6); order-service does not repeat that.
- [ ] **Pick and wire a test framework** (e.g. Vitest or Jest) with a `test` script, before the
      first module lands — core-service shipped with zero tests; this service moves money and
      does not get that pass.
- [ ] `tsconfig.json` — same strictness as core-service (`strict: true`, `noImplicitAny: true`,
      `experimentalDecorators`, `emitDecoratorMetadata`), CommonJS + `nodenext` resolution (no
      `"type": "module"`), no `.js` extensions on relative imports.
- [ ] `lib/config/env.ts` — zod-validated, namespaced (`env.db`, `env.redis`, `env.jwt`,
      `env.kashier`, `env.regions`). `env.db`/`env.regions` must support **multiple** regional
      connection configs from the start (even if only one region is live initially) — retrofitting
      sharding later is far more expensive than starting with a `Record<region, DbConfig>` shape.
- [ ] `lib/di/tokens.ts` + `lib/di/containers.ts` — empty container ready for module registration.
- [ ] `lib/http/response.ts` — the envelope helpers (`sendSuccess`, `sendError`, `sendPaginated`),
      copied from core-service's confirmed shape (`05-folder-structure.md` §4).
- [ ] `lib/error/AppError.ts` + `lib/error/errorHandler.ts` — copied as-is from core-service's
      pattern.
- [ ] `lib/auth/jwt.ts` (pure verify, no app import — see `05-folder-structure.md` §2.1),
      `lib/auth/guard.ts` (`authenticate` middleware).
- [ ] `pkg/cache/` + `lib/cache/init.ts` — Redis wiring, namespaced keys per
      `02-database-design.md` §6.
- [ ] `pkg/core-client/` (`ICoreServiceClient` + a stub implementation) + `lib/core-client/init.ts`
      — registers the stub in DI now; real HTTP implementation swaps in later with no call-site
      changes. See `01-system-design.md` §3.1.
- [ ] `lib/cache/invalidation-subscriber.ts` — subscribes to `core:invalidate:{entityType}` and
      deletes the matching `cache:core:{entityType}:{id}` key. See `01-system-design.md` §5.1.
- [ ] `pkg/ws-gateway/` + `lib/ws/init.ts` — the shared WebSocket base adapter and this service's
      wiring of it to its own Redis channels. See `01-system-design.md` §5.2.
- [ ] `pkg/id` — the Snowflake ID generator (needed by the very first migration's application
      code, build it here even though `04-modules/orders.md` also lists it, so it's not
      module-specific tech debt).
- [ ] `app.ts` / `server.ts` — middleware order and graceful shutdown per
      `05-folder-structure.md` §7, extended for multi-region pool shutdown + Redis `.quit()`.
- [ ] `src/routes.ts` — empty router tree, ready for each module to mount into.

## 1. Module build order

```
1. orders               ── everything else references an orders row
2. payments              ── orders' ONLINE path calls into this synchronously
3. delivery-agent        ── depends on orders (READY_FOR_PICKUP trigger) and payments (DELIVER side effects)
4. restaurant-finance    ── pure read layer over payments' tables, built last
```

This order is not arbitrary — it follows the actual call-dependency graph documented in each
module's business-logic doc (`04-modules/*.md` §"Interaction with..." sections). Building out of
this order means stubbing cross-module calls that will need to be un-stubbed later; building in
this order means every cross-module call is wired against real code the moment it's written.

## 2. Per-module checklist (repeat for each of the four modules)

1. **Migration(s)** — tables, enums, constraints, indexes for *this module's* tables only (see
   the specific list in that module's doc, §"Implementation plan" step 1). Run `knex
   migrate:latest` against a local dev DB before writing any application code against the schema.
2. **Entities** (`entity/*.entity.ts`) — one per table, plain classes, `constructor(data:
   Partial<X>)`.
3. **Repository** (`repository/<module>.repository.ts`) — exported functions only, explicit
   column lists (no `select *`), every multi-row fetch reviewed against the "no N+1" rule below
   before merging.
4. **Service** (`service/*.service.ts`) — business logic, state machines, cross-module calls.
   This is where the business-logic doc's numbered flows get translated into code 1:1 — if the
   code doesn't match the doc's step list, update whichever one is wrong before merging, don't
   let them silently diverge.
5. **Request DTOs** (`dto/request/*.dto.ts`) — class-validator decorated.
6. **Response DTOs** (`dto/response/*.response-dto.ts`) — explicit fields, `static from(...)`
   mapper, bigint ids stringified. **New discipline vs. core-service** — see
   `05-folder-structure.md` §3.1.
7. **Controller** (`controller/*.controller.ts`) — thin: `validateBody` → service call →
   `sendSuccess(res, ResponseDto.from(...))`.
8. **Routes** (`routes.ts`) — declare the router, apply `authenticate`/`rbac`/`idempotency`
   middleware per `03-api-contract.md`'s per-endpoint auth column.
9. **Mount** — add the module's router to `src/routes.ts` **in the same PR**. (Core-service's
   `productRouter` was built and never mounted — `05-folder-structure.md` §6 — this step exists
   specifically so that never happens here.)
10. **Unit tests** — the state machine / business-rule table for this module (each has one:
    orders' verb table, payments' ledger-direction table, delivery-agent's status verb table).
11. **Integration test** — at least the primary happy path against a real (test) DB connection.
12. **Update this doc set** if implementation revealed the design doc was wrong — the docs are a
    living contract, not a one-time artifact; a merged PR that contradicts its own module doc
    without updating it is an incomplete PR.

## 3. Cross-cutting concerns to land alongside the first module (`orders`), not deferred

- **Idempotency middleware** (`lib/Idempotency`, this service's own table-backed version per
  `02-database-design.md` §3.10) — needed by `POST /orders` from day one.
- **Region routing** — even a single-region deployment should go through the same
  `resolveRegionConnection(region)` code path a multi-region one would, so region #2 is a config
  change, not a rewrite.
- **Correlation-ID middleware** — copy from core-service unchanged.
- **RBAC middleware shape** — even if the concrete permission-checking implementation isn't fully
  built out, the `rbac({resource, action})` middleware factory and its DI-injected
  `IPermissionChecker` interface should exist from the first protected route, per
  `05-folder-structure.md` §2.1.
- **`ICoreServiceClient` (stub)** — the `orders` module is the first real caller (branch, address,
  product price/stock lookups on order creation); build the interface and stub together with it,
  per `01-system-design.md` §3.1, not deferred to whichever module happens to need a second method.
- **Cache-invalidation subscriber** — `orders`' product-stock read is the first place a stale cache
  read is a real correctness bug, so the subscriber (`01-system-design.md` §5.1) lands with it.

## 4. Explicitly deferred (not blocking this service's initial build)

- Analytics event emission transport (Kafka/SQS/etc. — infra decision). Until chosen, emit
  events through a `pkg/events` interface with a no-op/log-only implementation, so the call sites
  (`order.created`, `order.delivered`, `payment.succeeded`, etc.) exist in the code now and only
  the transport implementation swaps in later.
- **No longer deferred** (resolved, now in scope — see §0/§3 above): the real-time gateway
  (built as a shared `pkg/ws-gateway` base each service runs its own instance of, not a bespoke
  subscriber-side build-out — `01-system-design.md` §5.2), and the archive-storage destination
  for old order-year partitions (a cold Postgres database per country — `01-system-design.md`
  §7.4/§11). Kept here as a note so this doesn't read as still-open if skimmed out of context.
- Exact commission rate, delivery-fee formula, agent per-delivery earning rate, assignment
  response-window duration, and max-reassignment-attempt count — all flagged as configuration
  values to be supplied by the team, not hardcoded guesses (see the "Open question" callouts in
  `04-modules/payments.md` and `04-modules/delivery-agent.md`).
- Kashier field/endpoint details marked **VERIFY AT IMPLEMENTATION** in
  `07-kashier-integration.md` — these need a live Kashier sandbox account to confirm before the
  `payments` module's Kashier-facing code is finalized (the ledger/DB logic around them can be
  built and tested with a fake/mock provider client in the meantime).

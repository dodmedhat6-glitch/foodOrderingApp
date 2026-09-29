# AGENTS.md — Orders & Payments Service (DODS)

Governance rules for anyone — human or AI agent — contributing code to this repository. This is
the terse, authoritative reference; the reasoning and evidence behind each rule live in
`docs/` (linked inline below). If this file and a `docs/` file ever disagree, treat that as a bug
to fix (update whichever is wrong), not a reason to guess.

**Read first, in order, before writing code:** `docs/01-system-design.md`,
`docs/02-database-design.md`, `docs/05-folder-structure.md`, `docs/03-api-contract.md`, then the
relevant `docs/04-modules/*.md` for the module you're touching.

## 1. What this service is (and isn't)

This service owns **orders, payments, delivery assignment/lifecycle, agent presence/earnings, and
restaurant-facing finance views** — nothing else. It does not own: users/auth/RBAC identity,
restaurants/branches/menu/products (all core-service), analytics/reporting (a separate,
not-yet-started service), incentives/promotions (explicitly out of scope), or infrastructure/CI
(DevOps, not yet started). If a task looks like it belongs to one of those, stop and flag it
rather than building it here.

## 2. The `pkg` / `lib` / `app` boundary — non-negotiable

- **`pkg/`**: zero dependency on `lib/`, `app/`, `process.env`, or the DI container. Pure
  adapters around a third-party technology, configured entirely through constructor parameters.
  Must be copy-pasteable into an unrelated project. Examples: `pkg/kashier`, `pkg/cache`, `pkg/id`.
- **`lib/`**: may depend on `pkg/`. Builds concrete provider instances from `env`, registers them
  in DI, hosts generic cross-cutting middleware (auth token verification, error handling,
  idempotency, correlation IDs, the response envelope). May import from `app/` **only** inside
  the DI composition root (`lib/di/containers.ts`). Anything else in `lib/` reaching into `app/`
  is a boundary violation — this is the one mistake core-service made
  (`lib/auth/guard.ts`/`lib/auth/rbac.ts` importing app code) that we do not repeat here: keep
  JWT verification itself pure in `lib/auth/jwt.ts`, and inject any domain-aware permission
  checker via an interface, never a direct import.
- **`app/`**: everything domain-specific. May depend on `lib/`, `pkg/`, and other `app/*`
  modules.

Full detail and the reference example (email/cache pattern) to copy: `docs/05-folder-structure.md` §2.

## 3. Module ownership — one writer per table

| Module | Owns writes to | Reads (own tables) | Reads (other services) |
|---|---|---|---|
| `app/orders` | `orders`, `order_items` | — | core-service: restaurant, branch, product, address, user |
| `app/payments` | `transactions`, `restaurant_balances` | `orders` (via `app/orders`'s exposed functions, not direct SQL) | core-service: user (payout bank details) |
| `app/delivery-agent` | `deliveries`, `delivery_assignment_attempts`, `agent_presence`, `agent_earnings` | `orders` (read + the one exposed side-effect function) | core-service: user, branch |
| `app/restaurant-finance` | *(none — read-only)* | `transactions`, `restaurant_balances` | core-service: restaurant owner identity |
| *(all, migration-seeded only, no runtime writer)* | `payment_providers` | — | — |

Never write to a table another module owns via a direct repository call across module
boundaries. If module A needs module B to change state B owns, call an explicitly exported
service function on B (in-process — this is a monolith-per-region, not microservices-within-a-
microservice, so this is a plain function call through DI, never an HTTP hop). Cross-module reads
of another module's tables (e.g. `restaurant-finance` reading `transactions`) are fine as long as
they're reads only.

## 4. Naming conventions

| What | Convention |
|---|---|
| Files | kebab-case, always (`create-order.dto.ts`, `order.response-dto.ts`) — no exceptions, no snake_case, no camelCase filenames |
| Repository files | always `repository/<name>.repository.ts` — never `.repo.ts`, never a `repo/` folder |
| Error-constants file | always `errors.ts` (plural) |
| DB tables | plural snake_case |
| DB columns | snake_case |
| FK constraint names | `fk_<table>_<column>` |
| Unique constraint names | `uq_<table>_<cols>` |
| Index names | `idx_<table>_<col(s)>` |
| Classes | PascalCase |
| Interfaces | `I`-prefixed (`ICacheProvider`) |
| Enums (TS) | PascalCase type, `SCREAMING_SNAKE_CASE` or lowercase string members |
| DB enums | native Postgres `ENUM` type per column (see §6) |
| DI tokens | `Symbol.for('<PascalCaseName>')` in one flat `lib/di/tokens.ts` |
| Exports | named exports only, no default exports |
| Money fields | `<name>Minor` (TS) / `<name>_minor` (DB) — integer, smallest currency unit, never a float |
| Timestamps | `<verb>_at` (DB, `timestamptz`) / `<verb>At` (TS, ISO-8601 string in responses) |
| IDs in responses | always serialized as strings, never raw numbers (bigint precision) |

Full rationale and the specific core-service inconsistencies these rules were written to avoid:
`docs/05-folder-structure.md` §3, §6.

## 5. Response contract

Every HTTP response (except the provider webhook endpoint) uses:
```
success: { success: true, data: <ResponseDto|ResponseDto[]>, meta?: {...} }
error:   { success: false, data: { message: string, code?: string } }
```
`data` on a success response is **always** an explicit response DTO — never a raw entity, never a
raw repository row, never an ad-hoc inline object. This is the one deliberate deviation from
core-service (which has no response-shaping layer at all — see `docs/05-folder-structure.md`
§3.1). Every DTO field is listed explicitly; no `Partial<T>`, no spreading an entity into a
response object.

## 6. Database rules

- **`TIMESTAMPTZ`, never bare `TIMESTAMP`.** This service is multi-region; every instant must be
  unambiguous UTC. (Core-service uses bare `TIMESTAMP` — do not copy that here.)
- **Native Postgres `ENUM` types** for closed vocabularies (`order_status`, `transaction_type`,
  `delivery_status`, etc.), not `CHECK` constraints. New enum values are added via `ALTER TYPE
  ... ADD VALUE` in their own migration, never combined with a migration that uses the new value.
- **Every monetary column is `bigint`, storing minor units.** Never `decimal`/`numeric` for
  money, never a float.
- **Migrations use raw SQL (`knex.raw(...)`), not the knex schema builder** — matches
  core-service exactly.
- **Region column on every shardable table**, denormalized, set once at insert, never updated.
- **Snowflake-style application-generated IDs** for `orders.id` and `transactions.id` (the two
  aggregate roots an external actor might reference before we know which shard they live in) —
  see `docs/02-database-design.md` §4. All other tables use ordinary per-shard `bigserial`.
- **No foreign keys into core-service's database.** Every reference to a user/restaurant/
  branch/product/address is a plain `bigint` "soft reference," validated at the application layer
  against a cached core-service lookup, never a DB-level constraint.
- **Index every query pattern you actually ship, and no others.** Before adding an index, name
  the specific endpoint/query it serves (see the tables in `docs/02-database-design.md` §3 for
  the pattern — every index there has a one-line comment naming its endpoint). Do not add
  speculative indexes for queries that don't exist yet.

## 7. Performance rules — this is a high-write, latency-sensitive, sharded system

- **No N+1 queries, anywhere.** A list endpoint returns list-shaped DTOs without child
  collections (see `docs/03-api-contract.md`'s `OrderListItemResponseDto` — no `items` array in
  list views); a detail endpoint that does need child rows (e.g. `GET /orders/{orderId}` and its
  `order_items`) fetches them in one joined/batched query, never one query per parent row. Any
  loop containing an `await db(...)` call is a review-blocking finding.
- **Every list endpoint is paginated (cursor-based) and bounded** (`limit`, capped at a sane
  maximum — no unbounded `SELECT *` list route exists anywhere in this service).
- **Batch cross-service lookups to core-service.** Resolving N product ids for an order is one
  batched call (or a cached multi-get), never N sequential HTTP calls.
- **Query builder by default; raw SQL only for measured hot paths**, per
  `docs/01-system-design.md` §3/§6 — this service's own access patterns are simple enough that
  the query builder is the right default; don't reach for raw SQL preemptively, and don't refuse
  it once profiling shows a real hot path needs it (e.g. `GET /restaurant/orders`).
- **Never touch the ledger (`transactions`/`restaurant_balances`) outside a single DB transaction**
  that also writes whatever business fact justifies the change. No code path updates
  `restaurant_balances.balance_minor` directly — only `applyLedgerEntry`, using its `version`
  column for optimistic-concurrency retry.
- **Redis is a cache/real-time layer, never a system of record** for anything durable — presence/
  location can live only in Redis because it's explicitly allowed to be eventually consistent and
  lossy; money and order state cannot.
- **Namespace every Redis key** (`orders:`, `agents:`, `cache:core:`) — this Redis instance is
  shared with core-service (`docs/01-system-design.md` §5); an unnamespaced key is a collision
  waiting to happen.

## 8. Sharding & regions

- Shard key is **region**, i.e. the restaurant/branch's **country** — one Postgres database per
  country. **Single primary, no read replicas at this stage** (documented future step, not part of
  the initial build — see `docs/01-system-design.md` §7.1).
- Every write path resolves its region **before** opening a DB connection; there is no
  "default region" fallback that silently writes to the wrong shard.
- `payment_providers` is the one table that's globally replicated (identical rows in every shard,
  migration-seeded, never runtime-written) — see `docs/02-database-design.md` §3.4.
- Cross-region reads (customer order history) default to a fan-out-and-merge across the small set
  of regions rather than a bespoke directory table — see `docs/01-system-design.md` §7.3. Don't
  build a directory-table mechanism preemptively; it's an explicitly-flagged fallback if region
  count grows large.
- `orders`/`order_items`/`transactions` are yearly range-partitioned within each shard; current
  year (+ grace window) is hot, older years move to a **cold Postgres database, one per country**
  via a scheduled background-worker job (see `docs/01-system-design.md` §7.4/§11 — this is the
  reference example for this service's background-worker pattern generally).

## 9. Cross-service integration & real-time — decided pieces

- **Core-service client is a thin `lib/` transport, not an interface-first `pkg/` adapter.**
  `lib/core-client` (`core-client.ts`, `errors.ts`, `types.ts`) is the single way to reach
  core-service. `CoreClient.request<T>({ method, path, body?, correlationId?, idempotencyKey? })`
  is generic: it owns the URL, the `x-api-key` header, retries and error mapping, and knows
  nothing about branches, products or orders — callers name the path and the response type.
  Import the `coreClient` singleton it exports, or resolve `tokens.CoreClient` from DI.
  - It lives in `lib/`, not `pkg/`, precisely because it depends on `env` and `AppError`, which
    §2 forbids `pkg/` from importing. Only `pkg/utils/retry` is pulled in from `pkg/`.
  - There is **no `ICoreServiceClient` and no stub implementation** — an earlier draft had both
    and they were removed. Do not reintroduce a domain-typed interface or fixture client
    without agreeing it first; test by stubbing `fetch`.
  - `CORE_SERVICE_BASE_URL` is an **origin only**, with no `/api` suffix: request paths carry
    the full prefix themselves, e.g. `"/api/internal/branches/123"`.
  - 5xx becomes a 503 `AppError` and is retried (3 attempts, 50ms → 500ms backoff); every other
    non-2xx becomes an `AppError` carrying the upstream status and is **not** retried.
  - Known gap: there is no request timeout, so a hung core-service holds the calling request
    open across all attempts. Accepted for now — raise it before adding one.
  - `docs/01-system-design.md` §3.1, `docs/04-modules/orders.md` and
    `docs/06-implementation-roadmap.md` still describe the superseded interface-plus-stub
    approach; this section wins where they disagree.
- **Critical cached core-service data is invalidated on write, not just TTL'd.** Product
  stock/price/`isAvailable` (and branch/restaurant operational status) get a Redis Pub/Sub
  invalidation event (`core:invalidate:{entityType}`) from core-service on write; this service
  subscribes and **deletes** the matching `cache:core:*` key. TTL remains a safety net underneath
  this, not the primary mechanism, for these specific fields. See `docs/01-system-design.md` §5.1 —
  this needs a small publish-side addition in core-service that does not exist yet as of this
  writing (`core-service/src/app/product/service/product.service.ts`).
- **WebSocket base is a shared `pkg/` adapter, not a shared running process.** `pkg/ws-gateway` is
  built to be copy-pasted into any service (core-service included) that needs to push real-time
  events to connected clients; each service runs its own instance against its own Redis channels.
  See `docs/01-system-design.md` §5.2.

## 10. Idempotency

- Every state-mutating endpoint that could plausibly be retried by a client (`POST /orders`,
  `POST /payments/init`) requires an `Idempotency-Key` header, enforced by middleware, backed by
  this service's own `idempotency_keys` table (this service has its own database — it cannot
  reuse core-service's Postgres-backed idempotency store even though it copies the same code
  shape). The stored key is scoped by a hash of the request body — reusing a key with a different
  body is a `409`, not a silent wrong replay (a gap the core-service implementation has that we
  fix here — see `docs/05-folder-structure.md` §4/`docs/03-api-contract.md` §0).
- Provider webhooks (Kashier) use their own idempotency scheme (`transactionId` + `status`, plus
  the DB unique constraint on `(provider_id, provider_reference_id)`), independent of the
  `Idempotency-Key` header mechanism — see `docs/07-kashier-integration.md` §4.2.

## 11. Testing

Core-service ships with zero tests and no test framework configured. **Do not inherit that gap
here** — this service moves money. A test framework is wired up in project setup
(`docs/06-implementation-roadmap.md` §0), and every module ships with at minimum: unit tests for
its state-machine/business-rule table, and one integration test for its primary happy path,
before that module's PR merges.

## 12. Tooling hygiene

- `eslint`/`prettier` are configured and wired to `lint`/`format` npm scripts from the first
  commit — core-service installed both and configured neither; don't repeat that.
- Every module's router is mounted in `src/routes.ts` in the **same commit/PR** that introduces
  it — core-service shipped a `productRouter` that was never mounted (dead code); this is exactly
  the mistake step 9 of the per-module checklist (`docs/06-implementation-roadmap.md` §2) exists
  to prevent.
- No `.js` extensions on relative TypeScript imports (CommonJS + `nodenext`, no `"type":
  "module"`) — pick one style and hold it, unlike core-service's mixed usage.
- Proofread file/class/token names before committing — do not let a typo become "the convention"
  the way `lib/knex/kenx.ts` and `PermissionsCashService` did in core-service.

## 13. What to copy from core-service exactly, unchanged

Express + `helmet` + `cors` + `express.json()` + `cookie-parser` + correlation-id middleware
order; `tsyringe` DI with arrow-function-class-property controllers; `AppError` +
pre-instantiated singleton error constants thrown without `new`; `class-validator`/
`class-transformer` request validation called explicitly at the top of controller actions; `zod`-
validated namespaced env config; graceful shutdown sequence (extended here to also close Redis
and every regional DB pool, not just one); the `allowScripts` allowlist in `package.json`.

## 14. Document map

| Doc | Covers |
|---|---|
| `docs/01-system-design.md` | Why: multi-region, consistency model, caching, sharding rationale |
| `docs/02-database-design.md` | Full schema, every table/column/index, and every fix made to the original draft |
| `docs/03-api-contract.md` | Every endpoint, request/response DTOs, auth/RBAC, error codes |
| `docs/04-modules/orders.md` | Order state machine, creation flow, cross-module hooks |
| `docs/04-modules/payments.md` | Ledger model, balance-crediting timing, webhook/refund/payout flows |
| `docs/04-modules/delivery-agent.md` | Assignment algorithm, retry limits, delivery state machine, presence |
| `docs/04-modules/restaurant-finance.md` | Read-only balance/payout views |
| `docs/05-folder-structure.md` | The `pkg`/`lib`/`app` boundary, file/module conventions, what NOT to copy from core-service |
| `docs/06-implementation-roadmap.md` | Build order, per-module checklist, project setup checklist |
| `docs/07-kashier-integration.md` | Payment provider integration: hashing, webhooks, refunds, payouts |

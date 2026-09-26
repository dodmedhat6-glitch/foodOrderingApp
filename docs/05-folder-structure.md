# Folder Structure & Conventions

> This document is derived from a full read-only audit of `core-service` (the sibling service
> this repo must match). Every rule below either (a) copies a confirmed core-service convention,
> or (b) explicitly fixes a drift/inconsistency the audit found in core-service, so we don't
> import its rough edges. Every deviation is called out and justified — nothing is changed
> silently. The authoritative, terse version of these rules lives in `AGENTS.md`; this document
> is the annotated explanation.

## 1. Top-level layout

```
order-service/
  src/
    app/            feature modules — HTTP, validation, business logic
    lib/            app-aware infrastructure & composition (env, DI, http, error, db, redis wiring)
    pkg/            app-agnostic technology adapters (zero knowledge of order-service)
    migrations/     knex migrations, raw SQL, one per file
    routes.ts       mounts every module router under its prefix
    app.ts          Express app factory (middleware order)
    server.ts       process bootstrap + graceful shutdown
  docs/             this documentation set
  AGENTS.md         governance rules for anyone (human or agent) contributing code
```

This is a direct copy of core-service's top-level shape (confirmed: `app/`, `lib/`, `pkg/`,
`migrations/`, `routes.ts`, `app.ts`, `server.ts`). Two things are deliberately **not** copied:

- **Postman scaffolding** (`postman/`, `.postman/`) — the audit found these are empty,
  auto-generated VS Code extension artifacts in core-service, not a real contract. We don't
  recreate empty scaffolding; if we want contract-testing collections later, they get built
  deliberately, named per module, and committed with actual content.
- **`workflow` as a bare text file** — core-service keeps its module-authoring checklist as an
  untracked-feeling loose file (`src/workflow`, plain text). We keep the equivalent checklist as
  a formal, versioned section of `06-implementation-roadmap.md` instead.

## 2. The `pkg` / `lib` / `app` boundary — the rule, precisely

This is the single most important structural rule in the codebase, and the audit found
core-service does not follow it perfectly (see §2.1 "known core-service wart — do not copy"). We
adopt the **strict** version:

> **`pkg/` may only depend on third-party packages and other files inside `pkg/`.**
> It never imports from `lib/` or `app/`. It never reads `process.env` or a config module. Every
> piece of configuration a `pkg/` module needs (host, port, credentials, timeouts) is passed in
> through its constructor as a plain object. A file in `pkg/` must be able to be copy-pasted into
> an unrelated Node project and still compile.
>
> **`lib/` may depend on `pkg/`.** It is the composition layer: it reads env config, builds
> concrete `pkg/` provider instances with that config, registers them in the DI container, and
> hosts genuinely generic cross-cutting middleware (error handling, correlation IDs, idempotency,
> the HTTP response envelope, JWT verification, the DI container itself). `lib/` must not import
> from `app/` **except inside the DI composition-root file** (`lib/di/containers.ts` necessarily
> references every app-level service to wire it up — that one file is exempt because its entire
> job is wiring, not logic).
>
> **`app/` may depend on both `lib/` and `pkg/`, and on other `app/*` modules.** This is where
> all order-service domain logic, HTTP handling, and validation lives.

### 2.1 Known core-service wart — do not copy

The audit found `core-service`'s `lib/auth/guard.ts` and `lib/auth/rbac.ts` import from
`app/auth/utils` and `app/user/enums`/`app/rbac/service/...` — i.e. "generic" auth middleware
reaching into domain code. **Order-service must not repeat this.** Concretely:

- JWT sign/verify (pure crypto, no domain knowledge) lives in **`lib/auth/jwt.ts`**, not inside
  any `app/` module, precisely so `lib/auth/guard.ts` (the `authenticate` middleware) never has
  to import from `app/`.
- Anything that genuinely needs domain knowledge to enforce (e.g. "does this user have the
  `orders:accept` permission on this restaurant") is injected into the middleware via the DI
  container as an interface (`IPermissionChecker`), with the concrete implementation living in
  `app/` — the middleware in `lib/` depends on the *interface*, not the app module. This mirrors
  the email/cache pattern below, which the audit confirmed is core-service's **cleanest** example
  of the boundary done right.

### 2.2 The pattern to replicate exactly: provider interface → pkg adapter → lib wiring

Copied verbatim from core-service's email/cache modules (confirmed by the audit as the correct
reference pattern):

```
pkg/cache/cache.interface.ts     ICacheProvider { get, set(key, value, ttlSeconds?), del }
pkg/cache/redis.ts               RedisCacheProvider implements ICacheProvider (ioredis, config via constructor)
lib/cache/init.ts                new RedisCacheProvider({ host: env.redis.host, ... }) → registered in DI as tokens.CacheProvider
```

Every external technology (Redis, the Kashier HTTP client, ID generation, geodistance math) gets
this same three-layer treatment: a `pkg/` adapter behind an interface, a `lib/` wiring file that
supplies env-derived config and registers it in the DI container, and `app/` code that only ever
depends on the interface via constructor injection.

## 3. `app/<module>` internal structure

The audit found **three different naming variants** for the repository layer across
core-service's own modules (`repository/*.repository.ts`, `repository/*.repo.ts`, and even a
`repo/` folder name in `app/auth/`), plus `errors.ts` vs `error.ts`. We pick one convention and
enforce it everywhere — no per-module variation:

```
app/<module>/
  controller/<module>.controller.ts      class, @injectable(), thin: validate → call service → respond via DTO
  service/<module>.service.ts            class, @injectable(), business logic, throws AppError instances
  repository/<module>.repository.ts      exported async functions operating on the knex instance (NOT a class)
  entity/<name>.entity.ts                plain class, constructor(data: Partial<X>), one per DB row shape
  dto/request/<name>.dto.ts              class-validator-decorated classes — validates incoming request bodies
  dto/response/<name>.response-dto.ts    plain classes with a static from(entity) mapper — shapes outgoing JSON
  enums.ts                               domain enums local to this module
  errors.ts                              pre-instantiated `AppError` singleton constants (plural, always)
  routes.ts                              Router instance, resolves controller from DI container
```

Rules, stated once so they don't drift per-module the way core-service's did:

- **Repository files are always `<name>.repository.ts` inside a `repository/` folder.** Never
  `.repo.ts`, never a `repo/` folder.
- **Always `errors.ts` (plural), never `error.ts`.**
- **All filenames are kebab-case.** The audit found core-service mixing kebab-case, snake_case,
  and camelCase file names (`customer-address.controller.ts` vs `reset_password.repo.ts` vs
  `knexConfig.ts`) — order-service picks kebab-case and applies it everywhere, no exceptions.
- Repositories are plain exported functions, not classes — this part of core-service *is*
  consistent and worth keeping (`export async function findOrderById(id, conn: Knex = db)`).
- Multi-word type names still use PascalCase inside the file regardless of the kebab-case
  filename (`create-order.dto.ts` exports `class CreateOrderDto`).

### 3.1 Why response DTOs are new here (the one deliberate deviation from core-service)

The audit confirmed core-service has **no response-shaping layer at all** — controllers pass raw,
ad-hoc plain objects assembled inline straight into `sendSuccess`. Request DTOs (`class-validator`)
exist; response DTOs do not. Order-service adds them:

```ts
// dto/response/order.response-dto.ts
export class OrderResponseDto {
  id!: string;                 // bigint → string (JS cannot safely represent 64-bit ints)
  status!: OrderStatus;
  paymentStatus!: OrderPaymentStatus;
  totalMinor!: number;
  currency!: string;
  items!: OrderItemResponseDto[];
  createdAt!: string;          // ISO-8601

  static from(order: Order, items: OrderItem[]): OrderResponseDto {
    const dto = new OrderResponseDto();
    dto.id = order.id.toString();
    dto.status = order.status;
    dto.paymentStatus = order.paymentStatus;
    dto.totalMinor = order.totalMinor;
    dto.currency = order.currency;
    dto.items = items.map(OrderItemResponseDto.from);
    dto.createdAt = order.createdAt.toISOString();
    return dto;
  }
}
```

Controllers **never** pass an entity or a raw repository row into `sendSuccess` — only a response
DTO (or an array of them, or a DTO wrapping a paginated list). This is enforced by convention and
by code review, not by a type-level trick, exactly like request-DTO validation isn't
type-enforced either in core-service.

Every DTO field is explicitly listed (no `Partial<T>`, no spreading an entity) so that a schema
change in the database or an internal entity can never silently leak into an API response, and so
`bigint` id columns get a single, consistent, deliberate serialization rule (stringified) instead
of the accidental precision loss/inconsistency you'd get from `JSON.stringify` on a raw bigint.

## 4. Response envelope

We **keep core-service's confirmed envelope** for maximum consistency across DODS services,
formalized through the response-DTO layer instead of ad-hoc objects:

```ts
// success
{ success: true, data: <ResponseDto | ResponseDto[]>, meta?: { nextCursor, hasMore, count } }

// error
{ success: false, data: { message: string, code?: string } }
```

The audit flagged the error shape (`data.message` instead of a top-level `error` field) as a
quirk worth deciding on deliberately rather than inheriting by accident — we deliberately **keep**
it, for cross-service consistency (a shared API gateway / client SDK across DODS services should
not have to special-case two different error envelope shapes per backend). We add one field:
`code` (a stable machine-readable string, e.g. `ORDER_NOT_FOUND`), since payment/order error
handling needs more than a human-readable string for client branching logic — this is additive,
non-breaking relative to core-service's shape.

## 5. Migrations & DB conventions

Matches core-service exactly **except one deliberate change** (timezone-aware timestamps, needed
because this service is multi-region):

| Convention | Core-service (confirmed) | Order-service |
|---|---|---|
| Migration tool | knex, raw SQL DDL via `knex.raw(...)`, no schema builder | **same** |
| Migration filename | `<14-digit-timestamp>_<snake_case_description>.ts` | **same** |
| Table names | plural snake_case | **same** |
| Column names | snake_case | **same** |
| Primary keys | `SERIAL`/`BIGSERIAL` per expected table size | **same**, plus application-generated Snowflake `bigint` ids for `orders`/`transactions` (see `02-database-design.md` §4) |
| FK constraint naming | `fk_<table>_<column>` | **same** |
| Unique constraint naming | `uq_<table>_<cols>` | **same** |
| Index naming | `idx_<table>_<col(s)>` | **same** |
| Enums | `TEXT`/`VARCHAR` + `CHECK (col IN (...))` | **native Postgres `ENUM` types** — deviation, see below |
| Timestamps | bare `TIMESTAMP` (no timezone) | **`TIMESTAMPTZ`** — deviation, see below |
| Seeding | inline numbered migrations, no separate `seeds/` dir | **same** |

**Deviation 1 — `TIMESTAMPTZ` instead of `TIMESTAMP`.** The audit explicitly flagged
core-service's lack of timezone-aware timestamps as something *not* to copy for a region-sharded
service: this service spans multiple regions/timezones, and every cross-region comparison
(archival cutoffs, "current year" boundaries, agent last-seen freshness) must be unambiguous UTC
instants. This is the one place we intentionally diverge from "match core-service exactly."

**Deviation 2 — native `ENUM` types instead of `CHECK` constraints.** The draft database diagram
(`databaseDesign.png`) itself already annotates columns as `enum`, and this service's status
columns (`order_status`, `transaction_type`, `delivery_status`, etc.) are genuinely closed,
small, stable vocabularies that benefit from a real type (self-documenting in `\d` output,
smaller storage than text, and Postgres will reject a typo at the exact column instead of only at
whatever a `CHECK` regex/list happens to catch). We accept the one operational cost this brings
(`ALTER TYPE ... ADD VALUE` must run in its own migration — documented in `02-database-design.md`
§2) as worth it for correctness. If this later proves painful operationally, dropping back to
core-service's `CHECK`-constraint convention is a one-migration-family change, not architectural.

## 6. What we explicitly do NOT copy from core-service (confirmed drift/bugs — see audit)

| Core-service issue (confirmed by audit) | Order-service rule |
|---|---|
| 3 different repository file/folder naming variants | one convention only — `repository/<name>.repository.ts` (§3) |
| `errors.ts` vs `error.ts` | always `errors.ts` |
| `lib/knex/kenx.ts` typo, `PermissionsCashService`/`tokens.PermissionCashService` ("cash"/"cache" typo) | proofread every file/class/token name before commit; no typo becomes "the convention" here |
| `productRouter` built but never mounted (dead route) | every module's router is mounted in `routes.ts` in the same PR that introduces the module — checklist item in `06-implementation-roadmap.md` |
| `eslint`/`prettier` installed but never configured, no `lint`/`format` npm scripts | ship a working `.eslintrc`/`prettier` config and `lint`/`format` scripts from the first commit |
| No tests, no test framework, at all | order-service is the payments/money-movement path — it ships with a real test setup from day one (framework choice + first tests land with the `orders` module, not deferred) |
| `lib/auth/guard.ts`/`lib/auth/rbac.ts` importing from `app/` | see §2.1 |
| Bare `TIMESTAMP` columns | `TIMESTAMPTZ` (§5) |
| Mixed import-extension style (`.js` suffix on some relative imports, none on others), no `"type": "module"` | order-service stays CommonJS like core-service (`nodenext` resolution, no `"type": "module"`), and **never** puts a `.js` extension on a relative TypeScript import — pick the no-extension style consistently |
| Hardcoded `import path from 'path/win32'` | plain `import path from 'path'` |
| `withCache` middleware built but never used anywhere | if we build a generic response-cache middleware, the module introducing the first real route must also be the module that uses it — no speculative unused infra |

## 7. What we copy exactly, unchanged

- Express + `helmet` + `cors` + `express.json()` + `cookie-parser` + correlation-id middleware,
  in that order, error handler always last (`app.ts` shape).
- `tsyringe` DI, `Symbol.for('<PascalCaseName>')` tokens in one flat `lib/di/tokens.ts`, grouped
  by comment headers.
- Controllers as arrow-function class properties (guarantees `this` binding as Express handlers
  without `.bind()`).
- `AppError` base class + pre-instantiated singleton error constants per module, thrown without
  `new` (`throw OrderNotFoundError`, not `throw new OrderNotFoundError()`).
- Request validation via `class-validator`/`class-transformer`, called explicitly at the top of
  each controller action (`await validateBody(CreateOrderDto, req.body)`) — not middleware-driven.
- `zod`-validated, nested/namespaced env config in `lib/config/env.ts` (`env.db.*`, `env.redis.*`,
  `env.kashier.*`), loaded once at process start.
- Graceful shutdown sequence in `server.ts`: stop accepting connections → let in-flight requests
  finish → destroy DB pool(s) → exit. **Extended** here to also close the Redis client
  (`ioredis`'s `.quit()`) and, since this service is multi-region, close **every** regional pool,
  not just one.
- `allowScripts` allowlist in `package.json` for native-build dependencies.

## 8. Module map for this service

See `06-implementation-roadmap.md` for build order and `04-modules/*.md` for business logic.
Folder names, matching the endpoint groupings given for this service:

```
app/orders/              customer order lifecycle, restaurant order ops, PATCH order status
app/payments/            payment init, provider webhooks, payment lookup, the transactions ledger
app/delivery-agent/      assignment/reassignment, agent presence, agent tasks, delivery status, earnings
app/restaurant-finance/  read-only balance + payout history views for restaurant owners/managers
```

`app/delivery-agent` owns writes to `deliveries`, `delivery_assignment_attempts`,
`agent_presence`, `agent_earnings`. `app/payments` owns writes to `transactions`,
`restaurant_balances`, `payment_providers` (the last one is migration-seeded only, never
runtime-written — see `02-database-design.md` §3.4). `app/restaurant-finance` only **reads**
`transactions`/`restaurant_balances` — it never writes them. This "one writer per table, multiple
readers across module boundaries allowed" rule is stated explicitly in `AGENTS.md`.

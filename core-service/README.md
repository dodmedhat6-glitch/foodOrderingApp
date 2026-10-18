# core-service

The identity and catalogue service of the platform. Every other service depends
on the data it owns: users, restaurants, branches, products, delivery addresses
and permissions.

**Stack:** Node.js · TypeScript (strict) · Express 5 · PostgreSQL + PostGIS ·
Knex · Redis · RabbitMQ · tsyringe · zod · Mailjet

[← Back to the platform overview](../README.md)

## What it does

| Area | What is implemented |
| --- | --- |
| Authentication | Register (customer or restaurant owner), login, refresh, staff invite acceptance. bcrypt hashing, JWT access + refresh tokens in `httpOnly` cookies. |
| Password reset | 6-digit OTP from `crypto.randomInt`, stored as a SHA-256 hash with a 10-minute expiry, sent through Mailjet. The endpoint requires an `Idempotency-Key` and never reveals whether an account exists. |
| Users | Profile read and update, system roles. |
| Restaurants | Created as `pending` at owner sign-up. Public listing with cursor pagination and filters; status changes by a system admin. |
| Branches | Location, opening hours, delivery radius, fees and commission. PostGIS "who delivers here?" search, cached in Redis. |
| Products | Categories, products, and per-branch price / stock / availability kept in step by a PostgreSQL trigger. |
| Addresses | Customer delivery addresses with a single default per user. |
| RBAC | System roles + restaurant-scoped roles with `resource:action` permissions, member → branch scoping, in-process permission cache. |
| Internal API | `/api/internal/*` for other services (branch, product, stock reserve/release, address, user lookups), protected by hashed API keys. |
| Events | Transactional outbox: domain changes are written to `event_outbox` in the same transaction and drained to RabbitMQ (`core.events`) by a separate worker. |
| Health | `GET /api/health` runs a database round-trip. |

## Highlights

- **Layered modules** (Routes → Controllers → Services → Repositories) wired by
  `tsyringe` dependency injection.
- **Two-level authorization**: system roles plus restaurant roles stored as
  `resource:action` pairs, with branch-level scoping carried in the token so
  most checks need no database hit.
- **Geospatial search** with a PostGIS `geography` column, a GIST index and
  `ST_DWithin`.
- **Transactional outbox** for reliable event publishing to RabbitMQ.
- **Redis** response-cache and idempotency-key middleware.
- **Transactional writes**: restaurant sign-up creates the user, restaurant and
  owner membership in one Knex transaction.
- **Cursor pagination** and whitelisted query filters (`eq`, `gt`, `lt`, `gte`,
  `lte`, `in`, `like`).
- **Swappable infrastructure** behind interfaces (`ICacheProvider`,
  `IEmailProvider`, message broker).
- **Operational basics**: correlation IDs, structured JSON logs with redaction,
  typed central error handling, zod-validated environment, `helmet`, CORS,
  graceful shutdown.

## Architecture

Each module under `src/app/<module>/` is split into layers, and
each layer calls only the one directly below it:

```
Route        routes.ts     HTTP method + path, middleware chain (authenticate, rbac, cache)
  ↓
Controller   controller/   validates the body into a DTO, calls the service, shapes the response
  ↓
Service      service/      business rules, ownership checks, transactions
  ↓
Repository   repository/   Knex queries, maps snake_case rows to entity classes
  ↓
PostgreSQL
```

Alongside the layers, `dto/` holds `class-validator` input classes, `entity/`
holds classes that represent table rows, and `errors.ts` / `enums.ts` hold
module-specific errors and enums.

**Dependency injection.** Tokens are `Symbol.for(...)` values in
`src/lib/di/tokens.ts`. `src/lib/di/containers.ts` registers every controller
and service as a singleton and binds the infrastructure adapters as instances:
`CacheProvider` (Redis) and `EmailProvider` (Mailjet). Classes are marked
`@injectable()` and receive dependencies through `@inject(token)`. For example,
`AuthService` gets `UserService`, `RestaurantService`, `MemberService` and the
`IEmailProvider` through its constructor. Route files resolve their controller
from the container, and the middleware resolves the cache provider the same
way, so changing an adapter only touches the container.

## Core Modules

| Module | Responsibility |
| --- | --- |
| `auth` | Registration (customer / restaurant owner), login, token refresh, password reset by OTP, staff invite acceptance, email template |
| `user` | User accounts, system roles, profile read/update |
| `restaurant` | Restaurant records, lifecycle status (`pending`, `active`, `suspended`, `disable`), paginated public listing |
| `branch` | Branches with location, opening hours, currency, delivery radius and commission. Nearby search |
| `product` | Categories, products, and per-branch price / stock / availability |
| `addresses` | Customer delivery addresses with a single default address per user |
| `rbac` | Roles, permissions, restaurant members, member-branch assignments, permission cache |
| `internal` | Service-to-service endpoints for order-service (API-key protected) |
| `outbox` | `event_outbox` table and the drain service used by `src/worker.ts` |
| `health` | Database connectivity check |

## Shared Infrastructure

`src/lib/` holds application wiring:

| Path | Purpose |
| --- | --- |
| `config/env.ts` | Loads `.env` and validates it with a zod schema. Exposes a typed `env` object. |
| `di/` | `tsyringe` tokens and container bindings |
| `knex/` | Knex config (shared by the app and the Knex CLI) and the database instance |
| `auth/` | `authenticate`, `rbac()`, `requireRestaurantMember()`, `requireBranchAccess()`, cookie helpers |
| `cache/` | Redis provider instance and the `withCache()` response-cache middleware |
| `Idempotency/` | `idempotency()` middleware that stores responses under the `Idempotency-Key` header |
| `error/` | `AppError` (status code + operational flag) and the central error handler |
| `correlationId/` | Assigns a UUID to each request and returns it in `X-Correlation-ID` |
| `logger/` | Structured JSON logger |
| `http/` | Response envelope helpers, cursor pagination and query-filter parsing |
| `validation/` | `validateBody()` built on `class-transformer` + `class-validator` (whitelisting) |
| `email/` | Mailjet provider instance |

`src/pkg/` holds infrastructure adapters behind interfaces, with no
application dependencies:

- `cache/`: `ICacheProvider` and a `RedisCacheProvider` (ioredis)
- `email/`: `IEmailProvider` and a Mailjet provider
- `utils/`: time-unit helpers

## Key Backend Features

### Authentication

- Passwords are hashed with bcrypt.
- Login and registration issue an access token and a refresh token, signed with
  separate secrets and expiries (`ACCESS_EXPIRATION`, `REFRESH_EXPIRATION`).
- Both tokens are set as `httpOnly` cookies (`secure` in production). The
  refresh cookie is scoped to `/api/auth/refresh`, so the browser sends it only
  to that endpoint.
- The token payload carries the user's system role. Restaurant staff tokens also
  carry their restaurant, restaurant role and assigned branches, so
  authorization checks do not need a database lookup per request.
- `POST /api/auth/refresh` verifies the refresh token and issues a new access
  token. The refresh token itself is not rotated.
- Password reset sends a 6-digit OTP by email. Only its SHA-256 hash is stored,
  and it expires after 10 minutes.

### RBAC

Authorization has two levels.

1. **System roles** on the user: `system_admin`, `restaurant_user`, `customer`,
   `delivery_agent`.
2. **Restaurant roles** for `restaurant_user` accounts. A user joins a
   restaurant through `restaurant_members` with a role. `role_permissions` maps
   roles to `(resource, action)` permissions such as `core:product:create`.
   `member_branches` limits a member to specific branches.

Routes compose three middleware:

```ts
branchRouter.patch('/branches/:branchId',
    authenticate,                                      // verify access-token cookie
    requireBranchAccess('branchId'),                   // branch is in the token's branchIds
    rbac({resource: "core:branch", action: 'update'}), // role has the permission
    branchController.update
);
```

- `requireRestaurantMember` and `requireBranchAccess` let a `system_admin`
  through and check every other user against the restaurant or branches in
  their token.
- `rbac()` looks up the permission set for the user's restaurant role through
  `PermissionsCashService`. This is an in-process cache with a 1-hour TTL, so
  each process queries the database at most once an hour per role.
- On top of the middleware, services enforce ownership (for example, only the
  restaurant owner or a system admin can update a branch). Status changes on
  restaurants and branches are restricted to system admins.
- Owners are created automatically when they sign up. Other staff are invited:
  a user account and an `inactive` membership are created with branch
  assignments and an OTP. `POST /api/auth/accept-invite` then sets the password
  and activates the membership.

### Multi-Branch Product Model

A product belongs to a restaurant, but its commercial data belongs to a branch.
`product_branch_details` holds `price`, `stock` and `is_available` per
`(branch_id, product_id)`, with a unique constraint on the pair. The same burger
can cost and stock differently in each branch, or be unavailable in one of them.

The `trg_product_after_insert` trigger (`fn_insert_product_branch_details`)
runs after each product insert. It creates a row for every existing branch of
that restaurant, with price `0`, stock `0` and `is_available = false`. A new
product therefore starts hidden everywhere until a branch prices and enables
it. The trigger does not run when a branch is added, so branches created later
get no rows for existing products.

### Observability and Reliability

- **Correlation IDs:** every request gets a UUID, returned in the
  `X-Correlation-ID` response header and attached to error logs.
- **Centralized errors:** modules throw `AppError` instances with an HTTP
  status. The global handler logs every error and returns operational errors as
  is. Anything unexpected becomes a generic `500`, so internal details do not
  leak. All responses use the same `{ success, data, meta? }` envelope.
- **Logging:** a structured JSON logger (level, message, timestamp, metadata)
  writes to stdout.
- **Health check:** `GET /api/health` runs a database round-trip.
- **Environment validation:** the zod schema runs at import time. A missing
  required variable stops the process at startup, not on the first request
  that needs it.
- **Graceful shutdown:** on `SIGINT`/`SIGTERM` the HTTP server stops accepting
  connections, then the Knex pool is closed.

## Tech Stack

| Area | Technology |
| --- | --- |
| Runtime / language | Node.js 20+, TypeScript (strict mode) |
| HTTP | Express 5 |
| Database | PostgreSQL with PostGIS, Knex (query builder + migrations), `pg` |
| Cache | Redis via ioredis |
| Messaging | RabbitMQ via amqplib + amqp-connection-manager |
| DI | tsyringe, reflect-metadata |
| Validation | zod (environment), class-validator + class-transformer (DTOs) |
| Auth | jsonwebtoken, bcrypt, cookie-parser |
| Email | Mailjet |
| Security | helmet, cors |

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+ with the **PostGIS** extension available (the branches
  migration runs `CREATE EXTENSION IF NOT EXISTS postgis`)
- Redis 6+
- RabbitMQ (only needed for the outbox worker)
- Mailjet credentials to actually send emails (any non-empty value boots the
  server)

### Run it

```bash
cd core-service
npm install
cp .env.example .env      # fill in DB, JWT secrets, Mailjet, ORDER_SERVICE_API_KEY
npm run migrate           # renames legacy migrations if needed, then migrate:latest
npm run dev               # API on PORT (default 3000), under /api
npm run worker:dev        # outbox worker → RabbitMQ (separate terminal)
```

Check it:

```bash
curl http://localhost:3000/api/health
# {"success":true,"data":{"status":"ok"}}
```

### Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | API with `tsx watch` |
| `npm run worker:dev` | Outbox worker with `tsx watch` |
| `npm run build` / `npm start` / `npm run worker` | Compile with `tsc` and run from `dist/` |
| `npm run migrate` | Fix legacy migration names, then `migrate:latest` |
| `npm run knex -- <cmd>` | Any Knex CLI command (`migrate:list`, `migrate:rollback`, …) |

## Known Issues

- **Old databases:** two migrations were renamed so a fresh database builds
  cleanly. Always use `npm run migrate` (not raw `knex migrate:latest`), which
  rewrites the old names in `knex_migrations` first.
- Staff invitation OTPs are logged, not emailed yet.
- Refresh tokens are not rotated or revocable; reset OTPs are not single-use.
- The `product_branch_details` trigger runs on product insert only, so a branch
  created later gets no rows for existing products.
- No automated test suite yet.

## Roadmap

- [ ] Send invitation emails; make reset OTPs single-use (`consumed_at`)
- [ ] Rotate and revoke refresh tokens
- [ ] Reuse an incoming correlation ID when one is provided
- [ ] Automated tests (unit + integration against PostgreSQL)
- [ ] OpenAPI documentation
- [ ] Docker Compose for local development

See also: [development workflow](../docs/development-workflow.md).

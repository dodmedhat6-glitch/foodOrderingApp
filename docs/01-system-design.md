# System Design — Orders & Payments Service ("Service B")

> Source material: `system.png`, `system1.png`, the DODS PRD, and team whiteboard notes. This
> document translates those informal artifacts into a concrete, referenceable design so that
> every module we build afterwards has a single source of truth to check against.

## 1. Where this service sits in DODS

DODS is split into (at least) three service boundaries:

| Service | Responsibility | Status |
|---|---|---|
| **Core Platform Service** (`core-service`) | Users, auth, RBAC, restaurants, branches, menu, products | Live — this repo mirrors its conventions |
| **Orders & Payments Service** (`order-service`, this repo) | Order lifecycle, payments (online + COD), delivery assignment & lifecycle, agent presence/earnings, restaurant balance/payout visibility | **Building now** |
| **Analytics Service** | Aggregated reporting, dashboards, historical analysis | Not yet started (out of scope for this repo) |
| **DevOps / infra automation** | CI/CD, provisioning, observability stack | Not yet started (out of scope for this repo) |

Client apps consuming this service (per `system.png`): **Customer App**, **Restaurant Dashboard**,
**Delivery Agent App**, **Admin Dashboard**.

## 2. Governing constraints (from `system.png`)

The whiteboard names five constraints that shape every decision below:

1. **Multi-region** — DODS operates in more than one geographic region simultaneously.
2. **High write orders** — order creation/status transitions are a heavy write workload, not just
   a heavy read workload like a typical CRUD app.
3. **Strong consistency for payments** — money movement cannot be eventually consistent. A
   payment or ledger write must be immediately durable and immediately correct.
4. **Read-heavy discovery** (restaurant list, menu, prices, single menu item) — this is
   **core-service's** concern, not this service's. We call out this boundary explicitly so nobody
   accidentally rebuilds a menu cache here.
5. **Real-time orders / real-time tracking status** — order status and delivery-agent location
   need low-latency propagation to clients (poll or push), which is why Redis shows up as a
   shared real-time layer in `system1.png`.

## 3. Service-to-service communication (from `system1.png`)

```
                 async                              sync
   Analytics  <───────────  Orders & Payments  ───────────>  Core Platform Service
   (NoSQL)                  (this service)                   (users, restaurants, auth,
                                                               menu, product, ...)
```

- **Orders & Payments → Core Platform Service: synchronous.** We need the restaurant's branch,
  the customer's address, the delivery agent's identity, and RBAC checks to exist as strongly
  consistent, read-your-writes data *before* we can act on an order. These reads happen inline in
  the request path (with caching — see §5).
- **Orders & Payments → Analytics: asynchronous.** Order/payment/delivery events are emitted
  as domain events (outbox → message broker — exact transport is an infra decision, tracked as
  TBD until the DevOps piece exists) and consumed by Analytics at its own pace. This service never
  blocks on Analytics and never reads from it.
- **Rationale for the DB engine split** (explicitly stated on the whiteboard):
  - Analytics: "simple access pattern, doesn't require complex queries" → NoSQL is fine there.
  - Orders & Payments: "simple queries, not much relational... we can use an ORM" — but note
    this refers to *this service's own tables* (orders, order_items, transactions, etc.), which
    are simple enough that a query builder is sufficient — see §6.
  - Core Platform Service: "complex queries, performance, precise control → prefer raw SQL when
    needed" — this is **core-service's** convention (raw SQL for hot/complex paths), not a rule
    we need to re-derive; we borrow its query-layer conventions (see `05-folder-structure.md`)
    but our own query shapes stay simple (lookup by id, list by restaurant/customer/date range),
    so we default to the query builder and only drop to raw SQL for specific hot paths we
    identify by measurement (e.g. the restaurant order board query, active-delivery lookups).

### 3.1 Core-service client — one generic transport in `lib/`

The synchronous reads in the bullet above (branch, address, agent/user identity, and — see §5.1 —
product price/stock) all go through a single, deliberately thin client:

- `lib/core-client` holds three files — `core-client.ts` (the `CoreClient` class plus a
  `coreClient` singleton), `errors.ts`, `types.ts`. Its whole surface is one generic method:

  ```ts
  coreClient.request<T>({ method, path, body?, correlationId?, idempotencyKey? }): Promise<T>
  ```

  It owns the URL, the `x-api-key` header, retries and error mapping, and nothing else. Callers
  name the path and the response type; there are **no per-lookup methods** such as `getBranch` or
  `getProducts`, and no domain types in the client.
- It lives in `lib/`, not `pkg/`, because it reads `env` and throws `AppError` — both of which the
  `pkg`/`lib`/`app` boundary (`05-folder-structure.md` §2) forbids `pkg/` from touching. The only
  thing it borrows from `pkg/` is `pkg/utils/retry`.
- **There is no `ICoreServiceClient` interface and no stub implementation.** An earlier revision of
  this document specified both, and an interface-plus-fixture-stub pair was built and then removed:
  with core-service's `/api/internal/*` endpoints now live, the indirection bought nothing that
  stubbing `fetch` in a test does not. Do not reintroduce a domain-typed interface or a fixture
  client without agreeing it first (`AGENTS.md` §9).
- Behaviour worth knowing at the call site:
  - `CORE_SERVICE_BASE_URL` is an **origin only**, with no `/api` suffix — paths carry the full
    prefix, e.g. `"/api/internal/branches/123"`.
  - 5xx becomes a 503 `AppError` and is retried (3 attempts, 50ms → 500ms backoff). Every other
    non-2xx becomes an `AppError` carrying the upstream status and is **not** retried.
  - `204` resolves to `undefined`.
  - core-service wraps every response in its `{ success, data }` envelope, and `request<T>` returns
    the parsed body **verbatim** — it does not unwrap. Type `T` as the envelope and read `.data`,
    and define the payload type in the calling module: the client carries no domain types.
  - There is **no request timeout** yet: a hung core-service holds the calling request open across
    all three attempts. Known, accepted gap — raise it before adding one.

## 4. Consistency model

| Data | Consistency requirement | Why |
|---|---|---|
| Payments / transactions ledger | **Strong** (single-writer, same-region, transactional) | PRD: "strong consistency for orders & payments"; money cannot be eventually consistent |
| Order status transitions | **Strong** within the order's home region | An order is only ever mutated from the region it was created in (see §7 sharding) |
| Restaurant balance | **Strong**, derived transactionally from the ledger | Balance must never diverge from the sum of its ledger entries |
| Agent live location / presence | **Eventually consistent, low-latency** (Redis) | Real-time tracking tolerates a few seconds of staleness; durability is not required for every ping |
| Cross-region customer order history | **Eventually consistent read** (see §7.3) | Acceptable per PRD ("eventual consistency acceptable for analytics"); order history reads are not on the money-movement critical path |

## 5. Caching layer (Redis)

Per `system1.png`: **"We can use the same cache for both services [core-service and
order-service], as initially we won't need a lot of [read] analysis, but in the future... we'll
be able to have each service read from its own separate cache layer."** Both currently point at
the same Redis deployment; this repo must not assume exclusive ownership of the Redis
keyspace and must namespace every key (see `AGENTS.md` for the exact convention).

Redis is used here for:

1. **Idempotency keys** — `POST /orders` and `POST /payments/init` (see §8).
2. **Read-through caches** for data fetched synchronously from core-service (restaurant/branch
   snapshot, customer address, product price **and stock/availability**) so we don't re-fetch on
   every order-status read. TTL'd, never the system of record — but see §5.1, TTL is a safety net
   here, not the primary freshness mechanism for the fields that are critical enough to matter.
3. **Agent presence / live location** — `GEOADD`/`GEOSEARCH` for nearest-agent lookups plus a
   plain key for last-seen timestamp. This is the *live* view; `agent_presence` in Postgres (if
   kept at all) is a periodically-flushed durability snapshot, not the hot path.
4. **Rate limiting** (optional, shared middleware from core-service conventions if present).
5. **Real-time status fan-out** — order-status-changed and delivery-status-changed events are
   published on Redis Pub/Sub channels that this service's own WebSocket gateway instance
   subscribes to (see §5.2). This repo owns both publishing and, now, its own gateway process.
6. **Critical-data invalidation** — a subscriber that deletes stale `cache:core:*` entries the
   moment core-service writes the underlying row, rather than waiting out the TTL (see §5.1).

### 5.1 Cache invalidation for critical core-service data

Not every core-service-sourced cache entry needs this — a short TTL is a fine tradeoff for data
where a few seconds of staleness is harmless (e.g. a restaurant's display name). It is **not**
fine for data where staleness causes a real problem:

- **Product stock / `isAvailable`** — the motivating example: if core-service decrements stock to
  zero and this service's cache still says "available," `POST /orders` can accept an order for an
  item that can't be fulfilled.
- **Product price** — a stale cached price charged to a customer is a direct money-correctness bug.
- **Branch/restaurant operational status** (open/closed, suspended) — an order placed against a
  branch core-service has just closed is a fulfillment failure, not just a UX glitch.

Mechanism: core-service publishes an invalidation event on a Redis Pub/Sub channel
(`core:invalidate:{entityType}`, e.g. `core:invalidate:product`) whenever it writes one of these
fields, payload `{ id, occurredAt }`. This service runs a small always-on subscriber (`lib/cache/
invalidation-subscriber.ts`) that, on receipt, **deletes** (never refreshes) the corresponding
`cache:core:{entityType}:{id}` key. Delete-not-refresh is deliberate: the subscriber doesn't need
to know core-service's full response shape, only that "this key is no longer trustworthy" — the
next reader repopulates it synchronously from core-service, correctly, on demand. The existing
short TTL (§5 item 2) remains in place underneath this as a safety net for a missed/dropped event,
not as the primary freshness mechanism for these specific fields.

**Cross-repo dependency, stated explicitly so it isn't silently assumed:** this requires
core-service to add a publish call at the point it writes `product_branch_details.stock` / `.price`
/ `.is_available` (and branch/restaurant status, if/when that exists) — see
`core-service/src/app/product/service/product.service.ts`. That publish call does not exist yet in
core-service as of this writing; this service's subscriber is built against the channel contract
above regardless, so the two sides can land independently and start working the moment core-service
adds its half.

### 5.2 Shared WebSocket base

Real-time fan-out (§5 item 5) needs a WebSocket layer, and per the whiteboard note in §5, this
needs to be usable by more than just this service (core-service has its own future real-time needs,
e.g. a stock-out banner). Rather than standing up one centralized gateway process every service
hops to (extra infra, extra network hop, a new shared-ownership question), this is built as a
**generic, in-process adapter any service instantiates for itself**:

- `pkg/ws-gateway` — wraps a WebSocket library (`ws`/`socket.io`), authenticates the connection
  (same JWT verification as HTTP — see `05-folder-structure.md` §2.1), tracks per-connection
  subscription topics (e.g. `order:{orderId}`, `agent:{agentId}`), and exposes `publish(topic,
  payload)`. Zero order-service domain knowledge — copy-pasteable into core-service unchanged, per
  the `pkg/` purity rule.
- `lib/ws/init.ts` — this service's own thin wiring: subscribes to this service's Redis Pub/Sub
  channels (`orders:status:{orderId}`, agent-location) and calls `publish()` on the matching topic.
- This resolves the item previously flagged as deferred in `06-implementation-roadmap.md` §4 (a
  future WebSocket/SSE gateway) — it's in scope now, but scoped as **a reusable base, not a shared
  running process**: order-service runs its own instance against its own channels; core-service
  adopts the same `pkg/` adapter (copied, per convention) for its own channels independently. There
  is no cross-service message routing at this stage — if a unified gateway is needed later, this
  adapter is the seed to extract one from, not something built preemptively now.

## 6. Data layer choice

- **PostgreSQL**, one logical schema, physically **sharded by region** (see §7).
- **Query builder** (Knex, matching core-service — confirmed in `05-folder-structure.md`) for the
  vast majority of access patterns, because our access patterns are simple (point lookups,
  filtered lists, single-table or single-join aggregates).
- Raw SQL is allowed, same as core-service's convention, for specific measured hot paths — e.g.
  the restaurant order board (`GET /restaurant/orders?...`) which joins orders + order_items and
  is polled frequently by restaurant dashboards.
- No ORM entity-relationship magic (no lazy-loading, no implicit joins) — every query is explicit,
  every repository method states exactly what it selects. This is how we guarantee no N+1s (see
  `AGENTS.md` §"Performance rules").

## 7. Multi-region sharding strategy

### 7.1 Shard key

**Shard by `region` (derived from the restaurant's `country_code`/region assignment in
core-service).** Rationale, directly from the PRD and whiteboard:

- "Restaurants tied to primary region."
- "Orders processed in restaurant's region."
- "This field [orders/transactions] is much more heavy write ratio → sharding DB per region."

So the shard key for `orders`, `order_items`, `transactions`, `agent_earnings`,
`restaurant_balances`, and `agent_presence` (if persisted) is the **country of the restaurant
branch the order belongs to** (`country_code`, resolved via the branch's region assignment in
core-service) — **one Postgres database per country**, not a finer- or coarser-grained grouping.
The column that carries this on every table is still named `region` (see `02-database-design.md`
§1.9) for forward-compatibility — a single country could later be split into more than one
physical shard if its write volume ever outgrows one instance — but at v1 it is a strict 1:1
country → shard mapping, and "region" and "country" are the same thing in this codebase today.

**No read replicas at this stage.** Each country's shard is a **single primary Postgres
instance.** The PRD's "tips for scaling" note (horizontal scale, load balancer, read replicas,
multi-AZ per region) is a documented future step, not part of the initial build — it gets revisited
once a single primary's actual read/write load is measured against real traffic, not speculatively
built in ahead of that data. (This also removes any read-replica replication-lag question from the
consistency model in §4 for now — every read in a country goes to that country's one primary.)

### 7.2 Routing

- Every write request that creates or mutates an order carries (or resolves) a `region` /
  `country_code`. The service layer resolves `branchId → region` via the core-service branch
  lookup (cached), then routes the DB connection to that region's pool.
- `payment_providers` is a small, rarely-written **global reference table** — it is replicated
  identically into every regional shard (seeded via migration, not application-writable) rather
  than centralized, so that a payment-init call never needs a cross-region hop to read provider
  config.
- Delivery agents and restaurant owners operate within one region at a time (their home region);
  agent presence and earnings are written to that region's shard.

### 7.3 Cross-region reads (customer order history)

A customer's *home region* covers the overwhelming majority of their orders, but nothing stops
someone from ordering while traveling. Given the expected **small number of regions** (a
handful, not hundreds), `GET /customer/orders?year=YYYY` defaults to a **parallel fan-out**:
query every regional shard for that customer/year concurrently (short per-shard timeout), merge
by `createdAt DESC`, then apply the cursor to the merged result. For the common case (a customer
who has only ever ordered from their home region), this is indistinguishable in latency from a
single-shard query, since the other shards return empty quickly; it avoids maintaining any extra
bookkeeping table for what is, in practice, a rare edge case.

If the number of regions ever grows large enough that fan-out latency becomes a real problem, the
documented fallback is a small **global directory table**
`customer_region_activity(customer_id, region, last_order_at)`, written asynchronously
(best-effort, not on the payment critical path) whenever an order lands in a non-home region, so
the read path can query only the regions that actually matter for that customer instead of all of
them. This is **not built at v1** — it's a documented escape hatch, not part of the initial
schema (see `02-database-design.md` §7).

### 7.4 Current year vs archive

PRD: *"Orders: long-term retention; current year shown in apps; older orders archived to separate
storage."* Concretely:

- Each region's primary tables hold **hot data**: current year plus a rolling grace window (e.g.
  current year + previous 60 days, to cover year-boundary lookups) — enforced by partitioning
  `orders`/`order_items`/`transactions` by `created_at` (range partition per year) within each
  regional shard.
- A yearly **background worker** job detaches the prior year's partition from the hot regional
  (per-country) shard, copies its rows into a **cold Postgres database — one per country/region,
  mirroring the hot shard's own split** (archived data never crosses the country boundary it was
  created in) — then drops the detached partition from the hot shard once the copy is verified.
  Deliberately the same engine (Postgres) as the hot path, so no new storage technology to operate:
  just a separate, cheaper-tier instance per country, written to only by this job (batch,
  append-only) and read from only by the archived-year branch of `GET /customer/orders?year=YYYY`.
  This resolves the "archive storage destination" question previously tracked as TBD here and in
  `02-database-design.md` §7.1 and `06-implementation-roadmap.md` §4.
  This job is also this service's **reference implementation for the background-worker pattern**
  generally — see §11: later workers (idempotency-key cleanup, reconciliation scans) follow the
  same shape.
- `GET /customer/orders?year=YYYY` for the current year reads the hot partition; for older years
  it is routed to the archive path. This is why the endpoint takes `year` as a required
  disambiguator rather than open-ended pagination over all history.

## 8. Idempotency & strong consistency for money movement

- `POST /orders` and `POST /payments/init` are idempotent, keyed on a client-supplied
  `Idempotency-Key` header (same mechanism as core-service's `lib/Idempotency`, reused here —
  see `05-folder-structure.md`). The first successful response is cached (Redis, with a DB-backed
  fallback/audit row) and replayed verbatim for retries with the same key.
- Every write that touches `transactions` + `restaurant_balances` (or `orders.payment_status`)
  happens inside a single Postgres transaction, in the region owning that order — never a
  distributed transaction across shards.
- Kashier webhook processing is idempotent on `(transactionId, status)` (see
  `07-kashier-integration.md`) independent of our own idempotency-key mechanism, because webhook
  retries are provider-initiated and don't carry our header.

## 9. Non-functional targets (from PRD capacity section)

| Metric | Value |
|---|---|
| MAU / DAU | 1,000,000 / 200,000 |
| Requests/day (whole platform) | ~5.4M |
| Average RPS / Peak RPS | ~62 / ~620 |
| Read/write ratio (platform-wide) | 85% / 15% — **note:** this service is disproportionately write-heavy compared to the platform average, since discovery (the bulk of reads) lives in core-service |
| Orders storage growth | ~146 GB/year |
| Latency target (checkout) | 1–3s |
| Availability | High — order placement & payment are on the critical path |
| Log retention | 30 days |

These numbers justify: sharding per country to keep each shard's write volume manageable on a
single primary (see §7.1 — read replicas are a documented future step, not part of the initial
build), Redis in front of core-service lookups, yearly partitioning/archival, and keeping the write
path (order creation, status transitions, payment confirmation) as lean as possible (no synchronous
calls to Analytics, no unnecessary joins).

## 10. Explicitly out of scope for this service

- Menu/product/price CRUD and restaurant discovery (core-service).
- Incentives/promotions (per updated requirements — removed from the original draft contract).
- Recommendation systems, loyalty, AI-based delivery optimization, reviews (PRD: out of scope for
  DODS entirely).
- Analytics aggregation/reporting (Analytics service, not yet started).
- CI/CD, provisioning, observability stack (DevOps, not yet started) — this repo assumes a
  runtime environment is provided, and only documents what *it* needs from that environment
  (env vars, migration commands) in `AGENTS.md`.

## 11. Background workers

The order-archival job (§7.4) is this service's **first and reference** background worker — every
later one (idempotency-key cleanup sweeping expired `idempotency_keys` rows, a reconciliation scan
over `transactions` in `PENDING`/`PROCESSING` per `02-database-design.md` §3.3's
`idx_txn_status_pending`) follows the same shape rather than inventing a new pattern per job:

- **No HTTP surface.** A worker is a scheduled process (cron-triggered or a long-running process
  with an internal interval timer — infra decision on *how* it's scheduled, not in scope here), not
  a route handler. It lives alongside `app/<module>` code as `app/<module>/worker/<name>.worker.ts`
  (owned by the module whose tables it touches — the archival worker belongs to `app/orders`, the
  reconciliation scan to `app/payments`), reusing that module's repository functions.
- **Same regional connection-resolution code path as request-time code** — a worker iterates every
  configured region/country and, for each, resolves that region's connection exactly the way
  `resolveRegionConnection(region)` does for a live request (`06-implementation-roadmap.md` §3).
  There is no separate "batch" connection-handling code path to keep in sync with the request-time
  one.
- **Idempotent / safe to re-run.** A worker crashing mid-run and restarting must not double-process
  (the archival job verifies a copy before dropping the source partition, precisely so a crash
  between copy and drop can only be re-run safely, never lose or duplicate data).
- **Writes to a second connection pool when the destination isn't the hot shard** — the archival
  worker holds both the hot region's pool (source) and that region's cold archive-database pool
  (destination) for the duration of a run; this is the one place in the codebase two DB connections
  are legitimately open in the same logical operation, and it's the pattern to copy for any future
  worker that also writes cross-database (e.g. exporting to Analytics' store, once that's chosen).

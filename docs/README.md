# DODS — Orders & Payments Service — Documentation

This is the full technical design and implementation plan for `order-service`, the second
microservice in the DODS food-ordering platform (after `core-service`). Start with `AGENTS.md` in
the repo root for the terse rules; the documents here are the reasoning and detail behind them.

## Reading order

1. **[01-system-design.md](01-system-design.md)** — where this service sits in DODS, the
   governing constraints (multi-region, high-write, strong-consistency-for-payments), the
   service-to-service communication model, the consistency model, the Redis caching layer, and
   the region-sharding strategy.
2. **[02-database-design.md](02-database-design.md)** — the full, corrected schema (fixes the
   original draft's payouts table, ledger semantics, and delivery-history gaps), every table,
   column, index, and constraint, plus the ID-generation and sharding/partitioning scheme.
3. **[03-api-contract.md](03-api-contract.md)** — every endpoint from the given API surface, with
   full request/response DTO shapes, auth/RBAC requirements, and error conditions.
4. **[04-modules/](04-modules)** — one document per module, each covering business logic (state
   machines, calculation rules, cross-module interactions) and a step-by-step implementation plan:
   - [orders.md](04-modules/orders.md)
   - [payments.md](04-modules/payments.md)
   - [delivery-agent.md](04-modules/delivery-agent.md)
   - [restaurant-finance.md](04-modules/restaurant-finance.md)
5. **[05-folder-structure.md](05-folder-structure.md)** — derived from a full audit of
   `core-service`: the `pkg`/`lib`/`app` boundary rule, per-module file layout, naming
   conventions, and an explicit list of core-service inconsistencies this repo does **not**
   inherit.
6. **[06-implementation-roadmap.md](06-implementation-roadmap.md)** — the build order (orders →
   payments → delivery-agent → restaurant-finance) and the per-module checklist to repeat for
   each one.
7. **[07-kashier-integration.md](07-kashier-integration.md)** — the Kashier v3 payment provider
   integration: authentication, hash/signature generation, payment sessions, webhooks, refunds,
   and payouts.

## Source material this documentation is built from

- `../system.png`, `../system1.png` — whiteboard system-design notes.
- `../databaseDesign.png` — the original (rough) database draft; every deviation from it is
  called out explicitly in `02-database-design.md` §1.
- The DODS PRD (functional/non-functional requirements, capacity figures, order lifecycle).
- The given API endpoint list for this service ("Service B — Orders & Payments").
- A full read-only audit of `../core-service`'s actual code (conventions, tooling, and known
  drift/bugs to avoid repeating).
- Kashier's public developer documentation (`developers.kashier.io`).

## Open questions still owed to the team

These appear inline in the relevant doc, collected here for visibility:

- Delivery fee / service fee calculation formula (`04-modules/orders.md` §2).
- Platform commission rate model (`04-modules/payments.md` §2).
- Agent per-delivery earning rate (`04-modules/delivery-agent.md` §4).
- Assignment response-window duration and max-reassignment-attempt count
  (`04-modules/delivery-agent.md` §1–§2).
- Several Kashier field/endpoint details marked **VERIFY AT IMPLEMENTATION**
  (`07-kashier-integration.md`) that need a live sandbox account to confirm.

Resolved since the list above was first written (kept here for history, not re-litigated):
archive storage destination (`01-system-design.md` §7.4 — cold Postgres per country), read-replica
strategy (`01-system-design.md` §7.1 — none for now), the real-time gateway (`01-system-design.md`
§5.2 — shared `pkg/ws-gateway` adapter), critical-cache invalidation (`01-system-design.md` §5.1),
and the core-service sync client's interim shape (`01-system-design.md` §3.1 — stub now, real HTTP
later).

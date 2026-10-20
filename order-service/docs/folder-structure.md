# Folder structure

```
src/
  server.ts        API process: HTTP + WebSocket + core-events consumer
  worker.ts        background jobs process
  migrate.ts       knex migrations across every shard (also `node dist/migrate.js` in containers)
  app.ts           express setup
  routes.ts        mounts every module's router under /api
  app/             business modules
    order/         placement, status machine, reads, partition job
    payment/       Kashier sessions, webhook, refunds, ledger, expiry job
    delivery/      claim/unclaim/assign, dispatch sweep, settlement on delivered
    agent/         presence, task list, earnings, presence sweep
    finance/       restaurant balance, payouts, summary
    archival/      nightly move of prior-year data, idempotency purge
    health/
  lib/             app wiring (knows Express and env, no business rules)
    auth/  cache/  config/  core-client/  core-events/  correlation/  di/
    error/ http/   idempotency/  jobs/  knex/  logger/  messaging/
    sharding/  types/  validation/  websocket/
  pkg/             reusable, framework-free code (no env, no app imports)
    cache/  messaging/  payments/ (Kashier)  presence/ (Redis GEO)  utils/
  migrations/
scripts/           archive-now.ts
play/              local test scripts (not committed)
```

## Inside a module

```
app/<module>/
  routes.ts                       middleware + controller wiring
  controller/<module>.controller.ts   validate → call service → return a response DTO
  service/<module>.service.ts     business logic, owns transactions
  repository/<module>.repo.ts     SQL (Knex), functions not classes
  entity/  dto/  enums.ts  errors.ts  types.ts  jobs.ts (optional)
```

## Rules

- `pkg/` imports nothing from `lib/` or `app/`. `lib/` imports nothing from
  `app/` (the DI container is the one exception).
- Modules talk to each other through services, never another module's
  repository. Example: finance reads the ledger through the payment module's
  `LedgerService`. Archival is the deliberate exception: it copies raw rows
  between shards.
- Every HTTP response is a response DTO; entities never leave the service.
- Services and controllers are registered in `lib/di/container.ts`.
- A background job is `register({...})` in the module's `jobs.ts`, plus one line
  in `worker.ts`.

Full coding rules: `CLAUDE.md` at the service root.

# Status

Every planned phase is built.

| Phase | Delivered | Main code |
| --- | --- | --- |
| 0. Scaffolding | Sharded Postgres, Redis, RabbitMQ consumer, WebSocket, core client | `lib/` |
| 1. Orders | Placement with stock reservation, status machine, customer/restaurant reads, monthly partitions | `app/order/` |
| 2. Payments | Kashier checkout + webhook, COD, refunds (manual and automatic), unpaid-order expiry | `app/payment/` |
| 3. Delivery + agents | Redis presence, offer-and-claim dispatch, settlement on delivery, earnings | `app/delivery/`, `app/agent/` |
| 4. Restaurant finance | Balance, payouts, ledger summary | `app/finance/` |
| 5. Archival | Nightly move of prior years to the archive shard, merged reads, idempotency purge | `app/archival/` |

Changes from the original plan, in short:
- Partitions are native Postgres, not pg_partman.
- Core publishes one coarse event per entity (`core.<entity>.invalidated`), not
  fine-grained events. Cached copies are patched from the event payload.
- There is no deliveries table and no presence table.
- Online orders create the Kashier session at placement.
- The ledger has a `restaurant_id` column, so finance can read it per restaurant.
- Archival moves whole orders (with their children), not table by table.

## How it was verified

Scripts in `play/` (local, not committed), run against real Postgres, Redis and
RabbitMQ, plus Kashier's test environment:

| Area | Checks |
| --- | --- |
| Orders | Placement, idempotency, stock reservation and compensation, status machine, concurrency, cache |
| Core events | Every handler over RabbitMQ, end to end through core's outbox |
| Payments | Real card payments and a real refund through Kashier test mode; signature, duplicates, forgery, decline and retry, expiry |
| Delivery | Claim race, presence expiry, settlement replay, offline rules, Redis down |
| Finance | `test-finance.ts`: 48 checks incl. concurrent payouts and replay after losing Redis |
| Archival | `test-archival.ts`: 32 checks on 5,000 orders incl. crash recovery and merged reads |
| Indexes | `EXPLAIN` on the new queries: every one uses an index |

## Known limits

- Pagination uses `created_at` alone as the cursor, so two orders created in the
  same millisecond could be split across pages with one skipped. Rare in practice.
- Agent info on tracking has a name but no phone (core's user lookup has none).
- Kashier wallet payments and `void`/`reversal` webhooks haven't been tested
  live; the latter are logged, not handled.
- A finance summary over a previous year can double-count a row for one night
  if archival crashed mid-batch (it heals on the next run).
- The order-domain permissions are seeded by core migration `20261002090100`,
  which must have run on core's database.

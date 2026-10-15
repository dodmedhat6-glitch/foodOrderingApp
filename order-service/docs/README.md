# order-service docs

`order-service` owns everything that happens after a customer picks food:
orders, payments, delivery, the restaurant's money, and archiving old data.
Users, restaurants, branches, products and permissions live in `core-service`;
this service reads them from there.

All planned phases are built (see [status.md](status.md)).

## Start here

| Doc | What it covers |
| --- | --- |
| [system-design.md](system-design.md) | Processes, databases, Redis, RabbitMQ, WebSocket, how it talks to core |
| [api-contracts.md](api-contracts.md) | Every endpoint, who can call it, errors, WebSocket events |
| [database-design.md](database-design.md) | Tables, keys, indexes, partitioning |
| [folder-structure.md](folder-structure.md) | Where code lives and the layering rules |
| [status.md](status.md) | What each phase delivered, how it was verified, known limits |

Business rules, one file per module:

| Module | Doc |
| --- | --- |
| Orders | [business-logic/orders.md](business-logic/orders.md) |
| Payments (Kashier + COD) | [business-logic/payments.md](business-logic/payments.md) |
| Delivery & dispatch | [business-logic/deliveries.md](business-logic/deliveries.md) |
| Agents (presence, earnings) | [business-logic/agents.md](business-logic/agents.md) |
| Restaurant finance | [business-logic/restaurant-finance.md](business-logic/restaurant-finance.md) |
| Archival | [business-logic/archival.md](business-logic/archival.md) |
| Permissions | [business-logic/rbac.md](business-logic/rbac.md) |

[full_prd.md](full_prd.md) is the original product brief. It describes the
product's goals, not how this service is built.

## Running it

```bash
npm install
cp .env.example .env            # fill in DB, Redis, RabbitMQ, core and Kashier values
npm run migrate:all             # every region's hot shard
npx tsx scripts/migrate-all.ts --cluster=archive   # every region's archive shard
npm run dev                     # API (HTTP + WebSocket) on PORT
npm run dev:worker              # background jobs
```

`core-service` must be running, and its `ORDER_SERVICE_API_KEY` must equal this
service's `CORE_INTERNAL_API_KEY`.

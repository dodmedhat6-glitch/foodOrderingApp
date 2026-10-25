<div align="center">

# 📊 analytics-service

**Daily order and revenue rollups for QuickBite restaurant owners**

![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white)
![RabbitMQ](https://img.shields.io/badge/RabbitMQ-aio--pika-FF6600?logo=rabbitmq&logoColor=white)
![mypy](https://img.shields.io/badge/mypy-strict-2A6DB2)
![Ruff](https://img.shields.io/badge/lint-ruff-D7FF64?logo=ruff&logoColor=black)

[← Platform overview](../README.md)

</div>

---

Per-day rollups of QuickBite order activity. Consumes `order.events` from RabbitMQ, upserts aggregates into MongoDB, serves them read-only over HTTP. Python + FastAPI + pymongo + aio-pika, built to mirror the Node services next to it.

> [!NOTE]
> This service has no CI workflow yet — that one is still planned. Docker is here: [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) and [`docker-compose-test.yml`](docker-compose-test.yml), covered under [With Docker](#with-docker) below. Running it natively against a local MongoDB and RabbitMQ, as described next, needs none of them.

## What it does

| Piece | Details |
| --- | --- |
| Event consumer | aio-pika consumer on `order.events` (bindings `order.#`, `payment.#`), manual acks, dedupe by `eventId`, malformed messages to a dead-letter queue |
| Storage | Idempotent upserts of per-day, per-restaurant aggregates (orders count, revenue, average order) into MongoDB, with the indexes declared in `app/analytics/repository.py` |
| API | `GET /api/v1/analytics/restaurants/{id}/days?from=&to=` — read-only, JWT cookie auth shared with core, `analytics:read` permission checked against core with a TTL cache |
| Ops | `/health` reports Mongo and RabbitMQ status; structured JSON logs; graceful shutdown |
| Quality | `mypy --strict`, `ruff`, pydantic-validated settings |

Rules: [`CLAUDE.md`](CLAUDE.md). Design: [`docs/system-design.md`](docs/system-design.md). Coming from the Node services? Start with [`docs/node-to-python-mapping.md`](docs/node-to-python-mapping.md).

## Prerequisites

- **Python ≥ 3.11** (developed on 3.14).
- **MongoDB** on `localhost:27017` — a standalone `mongod` is enough:
  ```bash
  mongod --dbpath ./.mongo-data --port 27017 --bind_ip 127.0.0.1
  ```
- **RabbitMQ** on `localhost:5672` (`guest`/`guest`), management UI on `:15672` is handy for watching the DLQ.

You do **not** need Postgres, core-service or order-service: `play/` stands in for them.

## Setup

```bash
cd analytics-service
uv sync --extra dev          # creates .venv from pyproject.toml + uv.lock
cp .env.example .env
```

Edit `.env`:

| Variable                | For local dev                                  |
| ----------------------- | ---------------------------------------------- |
| `ACCESS_SECRET`         | any string ≥ 32 bytes (must match core's in a real stack) |
| `CORE_SERVICE_BASE_URL` | `http://127.0.0.1:3999` (mock-core)            |
| `CORE_INTERNAL_API_KEY` | anything                                       |

Every command below runs **from `analytics-service/`** with the venv's Python (`.venv/Scripts/python` on Windows, `.venv/bin/python` elsewhere). Shown as `python`.

> `play/` is gitignored. If you cloned the repo and it's missing, the four scripts are described in `docs/implementation-plan.md` Phase 6 — or ask an AI to regenerate them from that description (`docs/ai-prompts.md`).

## Run it — three terminals

**Terminal 1 — the API**
```bash
python server.py
```
```json
{"level": "info", "message": "mongo connected", "timestamp": 1791917380392, "db": "quickbite_analytics"}
{"level": "info", "message": "mongo indexes ensured", "timestamp": 1791917380444}
{"level": "info", "message": "rabbit connected", "timestamp": 1791917380470}
{"level": "info", "message": "event consumer started", "timestamp": 1791917380526, "queue": "analytics-service.order-events", "bindings": ["order.#", "payment.#"], "handlers": ["order.placed"]}
{"level": "info", "message": "http listening", "timestamp": 1791917380782, "port": 4100}
```

**Terminal 2 — mock core** (serves `GET /api/roles/{role}/permissions`)
```bash
python -m play.mock_core
```
Mirrors core's grants: only `owner` has `analytics:read`; `branch_manager` and `staff` don't. Each lookup is printed, so you can see the RBAC cache: one line per role per `RBAC_CACHE_TTL_SEC`.

**Terminal 3 — drive it**
```bash
python -m play.check_mongo --reset                               # start clean
python -m play.publish_test --restaurant 42 --total 2500         # prints eventId=...
python -m play.check_mongo --restaurant 42
#  {"date": "2026-10-13", "restaurant_id": 42, "currency": "EGP", ..., "orders_count": 1, "revenue_sum": 2500, ...}

python -m play.publish_test --restaurant 42 --total 2500 --event-id <the id above>
python -m play.check_mongo --restaurant 42                       # unchanged: deduped

python -m play.publish_test --restaurant 42 --total 1500
python -m play.check_mongo --restaurant 42                       # orders_count 2, revenue_sum 4000
```

Then the HTTP side (replace the date with today's UTC date):
```bash
curl -s localhost:4100/health
# {"success":true,"data":{"status":"ok","mongo":"up","rabbit":"up"}}

curl -s "localhost:4100/api/v1/analytics/restaurants/42/days?from=2026-10-13&to=2026-10-13"
# 401 {"success":false,"error":{"code":"UNAUTHENTICATED","message":"User not authenticated"}}

TOKEN=$(python -m play.mint_jwt)            # restaurant_user, owner of restaurant 42
curl -s -b "access_token=$TOKEN" "localhost:4100/api/v1/analytics/restaurants/42/days?from=2026-10-13&to=2026-10-13"
# {"success":true,"data":[{"date":"2026-10-13","ordersCount":2,"revenueMinor":4000,"currency":"EGP","avgOrderMinor":2000}]}

curl -s -b "access_token=$TOKEN" "localhost:4100/api/v1/analytics/restaurants/42/days?from=2026-10-13&to=2026-10-01"
# 400 ANALYTICS_INVALID_DATE_RANGE
```

More to try:

| Command | Expect |
| --- | --- |
| `python -m play.mint_jwt --restaurant-role branch_manager` | 403 `PERMISSION_DENIED` |
| `python -m play.mint_jwt --restaurant-id 7` | 403 (not a member of 42) |
| `python -m play.mint_jwt --expires-in -60` | 401 |
| `python -m play.mint_jwt --role system_admin` | 200 for any restaurant |
| `python -m play.publish_test --raw '{"nope":1}'` | message in `analytics-service.order-events.dlq` |
| `python -m play.publish_test --routing-key payment.completed` | logged "no handler", acked |
| `python -m play.check_mongo --indexes` | the four indexes from `app/analytics/repository.py` |

Stop the API with Ctrl+C: you should see `shutdown requested` → `event consumer stopped` → `shutdown complete`.

## Checks

```bash
python -m compileall -q -x "\.venv" .
ruff check .
mypy .
```

## With Docker

An alternative to the three terminals: MongoDB, RabbitMQ and the service, all containers.

```bash
docker compose up --build -d          # reads your .env, overriding only the hosts
docker compose logs -f analytics-service
curl http://localhost:4100/health
docker compose down                   # add -v to throw the rollups away
```

`.env` still supplies `ACCESS_SECRET` and `CORE_INTERNAL_API_KEY`; `MONGO_URI` and `RABBITMQ_URL` are overridden to the container hostnames. `CORE_SERVICE_BASE_URL` points at `host.docker.internal:3999` — `play/mock_core.py` on the host — because core-service is not part of this stack; override it with `CORE_SERVICE_BASE_URL_DOCKER`.

For a stack that needs no `.env` at all — CI, or a clean clone — use the test file. Storage is tmpfs, so Mongo and RabbitMQ start empty every run, and the host ports are shifted (`14100`, `17017`, `17672`, management UI on `17673`) so it can run next to the dev stack:

```bash
docker compose -f docker-compose-test.yml up --build -d
curl http://localhost:14100/health
docker compose -f docker-compose-test.yml down -v
```

Infrastructure only, for driving `play/*.py` from the host against throwaway stores:

```bash
docker compose -f docker-compose-test.yml up -d mongo rabbitmq
```

The image runs `python server.py` as an unprivileged user, with the venv resolved from `uv.lock` in a throwaway builder stage — no uv, no ruff and no mypy in the runtime image. Its `HEALTHCHECK` hits `/health`, which answers 200 whenever a read can be served: a broker blip reports `"rabbit": "down"` and `"status": "degraded"` rather than marking the container unhealthy.

## With the real publisher

order-service's worker drains its `events_outbox` onto `order.events` (`order-service/src/lib/events/`). With both running against the same broker, a COD order placed through `POST /api/orders` — or an online order once its payment is captured — shows up here within one drain tick (2 s) plus consumer latency.

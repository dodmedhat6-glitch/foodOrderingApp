# Node → Python mapping

You know `core-service` and `order-service`. This shows how each piece you know is written in `analytics-service`, and why it sometimes isn't written the same way. Python snippets are from this repo; Node snippets from the Node services.

**The architecture transfers unchanged; the idioms don't.** Layers, envelopes, error codes, the consumer's ack/nack logic: identical. How an object gets its dependencies, how a request carries its correlation id, how input is validated: that's where Python gives a different (usually shorter) answer.

1. [Language idioms](#1-language-idioms) · 2. [Layer by layer](#2-layer-by-layer) · 3. [Gotchas](#3-common-gotchas-when-porting) · 4. [When to break the mapping](#4-when-to-break-the-mapping)

---

## 1. Language idioms

| TypeScript | Python | Notes |
| --- | --- | --- |
| `class X { constructor(private readonly a: A) {} }` | `def __init__(self, a: A) -> None: self._a = a` | No parameter properties. `_a` = private by convention. |
| data-only class / `Partial<T>` constructor | `@dataclass(frozen=True)` | Generates `__init__`/`__eq__`/`__repr__`; `frozen` ≈ `readonly`. |
| `interface Foo { bar(): Promise<void> }` | `class Foo(Protocol): async def bar(self) -> None: ...` | **Structural** like TS: no `implements`; mypy checks it where the object is passed. |
| `enum` / `as const` strings | module constants (`ORDER_PLACED = "order.placed"`) or `StrEnum` | |
| `T \| undefined`, `a?: T` | `T \| None`, `a: T \| None = None` | One "nothing": `None`. |
| `x ?? y` | `x if x is not None else y` | `x or y` also replaces `0`, `""`, `[]`. |
| `Promise<T>` | `async def f() -> T` | Calling without `await` builds a coroutine and drops it. |
| `Promise.all` / `setTimeout` | `asyncio.gather` / `await asyncio.sleep(sec)` | **Seconds.** |
| `throw` / `try…catch` | `raise` / `try…except E as e` | `raise New(...) from exc` keeps the cause. Never bare `except:`. |
| arrow-function class property (keeps `this`) | plain `def` | `obj.method` is already bound in Python. |
| `export` / `import {f} from "./x"` | top-level names / `from lib.x import f` | Absolute imports from the service root. |
| `import type` to break a cycle | `if TYPE_CHECKING:` | Rarely needed if layering is respected. |
| `arr.map/filter` | list comprehensions | |
| `new Set` / `Map` | `frozenset` / `dict` | |
| `new Date()` / `toISOString()` | `datetime.now(UTC)` / `.isoformat()` | **Always `UTC`** — `datetime.now()` is naive local time. |
| `process.env.X` | a field on `lib.config.Env` | |
| class-validator decorators | pydantic **type annotations** | `int = Field(gt=0)` is the validator. |
| `tsc --noEmit` / eslint / prettier | `mypy .` / `ruff check .` / `ruff format .` | |
| `package.json` + lock / `npm ci` | `pyproject.toml` + `uv.lock` / `uv sync --extra dev` | |
| `tsx src/server.ts` | `python server.py` | |

---

## 2. Layer by layer

### 2.1 Config — `env.ts` → `lib/config.py`

```ts
const schema = z.object({ PORT: z.string().default("4000"), ACCESS_SECRET: z.string() });
export const env = { port: Number(schema.parse(process.env).PORT), ... };
```
```python
class Env(BaseSettings):
    model_config = SettingsConfigDict(env_file=..., extra="ignore")
    port: int = 4100  # "4100" in the env arrives as int
    access_secret: str  # no default = required; ACCESS_SECRET maps to it
```
Coercion is built in. **Difference:** no import-time global — `server.py` calls `Env()` once and passes values into constructors.

### 2.2 Logger + correlation id — `logger.ts`, `correlationId.ts`, `express.d.ts` → `lib/logger.py`

```ts
req.correlationId = id;                                       // middleware
logger.error("handler failed", { eventId, correlationId: req.correlationId });   // by hand, every call
```
```python
correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)
token = correlation_id.set(cid)  # RequestMiddleware / EventConsumer
logger.error("handler failed", eventId=event_id)  # formatter adds correlationId itself
```
A `ContextVar` is per-asyncio-task state (Node's `AsyncLocalStorage`): concurrent requests never see each other's value, and nobody threads it through signatures. Same JSON line as the Node logger; keys stay camelCase so one log query spans the platform.

### 2.3 Errors — `AppError.ts` + `errorHandler.ts` → `lib/errors.py`

```ts
export const OrderNotFoundError = new AppError("Order not found", 404);
app.use(errorHandler);
```
```python
ERR_INVALID_DATE_RANGE = AppError("ANALYTICS_INVALID_DATE_RANGE", 400, "`from` must be on or before `to`")
raise ERR_DATE_RANGE_TOO_LARGE.with_details(
    maxDays=366, requestedDays=span
)  # copy, never mutate the shared one
install_error_handlers(app)  # AppError, RequestValidationError -> 400, 404/405
```
Added: a stable `code` clients branch on. FastAPI validates input *before* your code runs, so its `RequestValidationError` needs a handler to get the platform envelope instead of FastAPI's `422 {"detail": …}`. Bugs become a 500 in `RequestMiddleware` (`lib/http.py`), not an `Exception` handler, because Starlette re-raises after running that one and the crash would be logged twice.

### 2.4 Middleware — `correlationId.ts` → `lib/http.py` `RequestMiddleware`

```ts
export function correlationId(req, res, next) { req.correlationId = ...; res.setHeader(...); next(); }
```
```python
class RequestMiddleware:
    async def __call__(self, scope, receive, send):
        token = correlation_id.set(cid)
        try:
            await self._app(scope, receive, send_wrapper)   # ≈ next()
        except Exception:
            ...render 500...
        finally:
            logger.info("http request", ..., status=status, ms=ms)
            correlation_id.reset(token)
```
Pure ASGI rather than `BaseHTTPMiddleware` (which runs the app in another task and can lose ContextVars). With `add_middleware` the **last added is outermost** — the opposite of `app.use` order.

### 2.5 Auth + RBAC — `guard.ts` + `rbac.ts` → `lib/auth.py`

```ts
router.get("/restaurants/:restaurantId/branches/:branchId/orders",
    authenticate, requireRestaurantMember(), rbac({ resource: "orders", action: "read" }), controller.list);
```
```python
@router.get("/restaurants/{restaurantId}/days",
    dependencies=[Depends(auth.require_restaurant_member()), Depends(auth.require(PERM_ANALYTICS_READ))])
```
Per-route middleware is a FastAPI **dependency**: it runs before the handler, raises to stop it, and can *return* a value. Both guards depend on `auth.authenticate`; FastAPI runs it once per request and shares the `Claims`. `Auth` gets the secret and the permission cache in its constructor — no global env. Core's wire claim `user_id` is validated by a pydantic model, then mapped to `Claims` (order-service does the same `user_id → userId` mapping). The permission cache is in-process (order-service uses Redis because its replicas share it; this service has no Redis) with single-flight so a cold role causes one core call, not fifty.

### 2.6 DTOs — `*.request.dto.ts` / `*.response.dto.ts` → `app/analytics/dto.py`

```ts
export class OrderResponseDTO { id!: string; static from(order: OrderEntity) {...} }
```
```python
class RestaurantDayResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    orders_count: int  # "ordersCount" on the wire

    @classmethod
    def from_entity(cls, day: AggRestaurantDay) -> Self: ...


class RestaurantDaysQuery(BaseModel):
    from_: date = Field(alias="from")  # `from` is a keyword
    to: date
```
`static from` → `@classmethod from_entity` (`from` is reserved). The query model is validated by FastAPI before the handler; cross-field rules (`from ≤ to`) stay in the service with the module's own error code.

### 2.7 Entities — `*.entity.ts` → `@dataclass` in `types.py`

```ts
export class OrderEntity { id: number; constructor(data: Partial<OrderEntity>) { this.id = data.id!; } }
```
```python
@dataclass(frozen=True)
class AggRestaurantDay:
    restaurant_id: int
    date: str
    orders_count: int
    revenue_sum: int
```

### 2.8 Repositories — knex functions → pymongo class in `repository.py`

| knex | pymongo |
| --- | --- |
| `.select(COLUMNS)` | projection `{"_id": 0, "date": 1, ...}` |
| `.where("a", x).where("b", ">=", y)` | `{"a": x, "b": {"$gte": y}}` |
| `.orderBy("date")` | `.sort("date", ASCENDING)` |
| `INSERT … ON CONFLICT DO UPDATE SET n = n + 1` | `update_one(filter, {"$inc": …, "$setOnInsert": …}, upsert=True)` |
| `ON CONFLICT DO NOTHING` | `insert_one` + `except DuplicateKeyError` |
| `CREATE UNIQUE INDEX` migration | `ensure_indexes()` at boot |
| `conn: Knex = db` for transactions | none — single-document writes are atomic |

A **class** holding its collection rather than functions importing a global `db`, because nothing here is global — `server.py` constructs `AggRestaurantDayRepo(db)`.

### 2.9 Services — `@injectable()` class → plain class in `service.py`

```ts
@injectable() export class OrderPlacementService {
    constructor(@inject(TOKENS.OrderNotifier) private readonly notifier: OrderNotifier) {}
    placeOrder = async (...): Promise<OrderResponseDTO> => { ... };
}
```
```python
class AnalyticsService:
    def __init__(self, restaurant_days: AggRestaurantDayRepo, max_range_days: int) -> None: ...
    async def get_restaurant_days(
        self, restaurant_id: int, start: date, end: date
    ) -> list[RestaurantDayResponse]: ...
```
The constructor signature *is* the dependency declaration. Returns DTOs, like `placeOrder` does.

### 2.10 Controllers + routes — `*.controller.ts` + `routes.ts` → `routes.py`

```ts
const controller = container.resolve<OrderController>(TOKENS.OrderController);
orderRouter.get("/orders/:orderId", authenticate, controller.get);
// controller.get: Number(req.params.orderId) -> service -> DTO -> sendSuccess(res, dto)
```
```python
def build_router(service: AnalyticsService, auth: Auth) -> APIRouter:
    @router.get("/restaurants/{restaurantId}/days", dependencies=[...])
    async def get_restaurant_days(
        restaurant_id: Annotated[int, Path(alias="restaurantId", gt=0)],
        query: Annotated[RestaurantDaysQuery, Query()],
    ) -> JSONResponse:
        return send_success(await service.get_restaurant_days(restaurant_id, query.from_, query.to))
```
FastAPI reads the handler's **signature** to extract and validate inputs, so the controller has nothing left to parse and collapses into the route. No `try/except`: errors propagate to the handlers, as Express 5 forwards a rejected promise.

### 2.11 Messaging — `rabbitmq.client.ts` + `core-events/consumer.ts` → `pkg/messaging.py` + `lib/events.py`

`amqp-connection-manager` → `aio_pika.connect_robust` (reconnects and restores queues, bindings, consumers). Only robust after the **first** connect succeeds, so `server.py` retries in the background when the broker is down at boot.

```ts
const fresh = await cacheProvider.trySet(`core-events:dedupe:${id}`, "1", TTL);
if (!fresh) { msg.ack(); return; }
try { await handler(payload, meta); msg.ack(); } catch { msg.nack(false); }
```
```python
handler = self._handlers.get(env.eventType)
if handler is None:
    await msg.ack()
    return
if not await self._deduper.mark_seen(env.eventId):
    await msg.ack()
    return
try:
    await handler(env.payload)
except Exception:
    await self._deduper.forget(env.eventId)  # so a DLQ replay re-applies
    await msg.nack(requeue=False)
    return
await msg.ack()
```
Dedupe is behind the `EventDeduper` Protocol because `lib/` can't import the Mongo repo; Mongo instead of Redis because our handlers aren't idempotent (`system-design.md` §5). Ack/nack are coroutines — `await` them.

### 2.12 Event handlers — `registerHandler(...)` → `build_handlers(service)`

```python
def build_handlers(service: AnalyticsService) -> dict[str, EventHandler]:
    async def on_order_placed(payload: dict[str, object]) -> None:
        await service.on_order_placed(
            OrderPlacedPayload.model_validate(payload)
        )  # (+ ValidationError -> AppError)

    return {ORDER_PLACED: on_order_placed}
```
A closure captures the service; the dict is handed to the consumer. No global registry, so no "registered twice" and no `resetHandlers()`.

### 2.13 DI + server — `container.ts` + `server.ts` + `app.ts` → `server.py`

```python
db = mongo[env.mongo_db]
service = AnalyticsService(AggRestaurantDayRepo(db), env.analytics_max_range_days)
auth = Auth(env.access_secret, PermissionsCache(core.get_role_permissions, env.rbac_cache_ttl_sec))
consumer = EventConsumer(broker, ConsumerOptions(...), EventIdsRepo(db), build_handlers(service))
server = _Server(uvicorn.Config(create_app(mongo, broker, build_router(service, auth)), ...))
```
No container: constructors are already injection points, and the whole graph fits on a screen in dependency order. A missing dependency is a `TypeError` at boot, not a resolution error at first use. uvicorn runs **inside** our event loop so one `main()` owns HTTP, Mongo and RabbitMQ and closes them in order; `_Server` stops uvicorn re-raising the signal over that cleanup.

---

## 3. Common gotchas when porting

1. **Missing `await`** returns a coroutine (truthy, useless). mypy reports `unused-coroutine` and type mismatches; at runtime you only get a warning.
2. **Naive datetimes.** Use `datetime.now(UTC)`, `AsyncMongoClient(tz_aware=True)`, `.astimezone(UTC).date()` for day buckets.
3. **Mutable defaults** (`def f(x=[])`) are shared across calls. Use `None` / `Field(default_factory=list)`.
4. **`round()` is banker's rounding** (`round(2.5) == 2`). Money uses integer half-up: `(2*total + n) // (2*n)`.
5. **`/` returns float** (`4000 / 2 == 2000.0`, serialized as `2000.0`). Use `//` for money.
6. **pydantic is lax**: `int` accepts `"42"` and `2500.0`, `date` accepts `"1760000000"`. Use `strict=True` or a `mode="before"` validator where the contract must be exact.
7. **`or` is not `??`.**
8. **ContextVars flow down, not up**: set request-wide values in the outermost middleware.
9. **Middleware order is reversed** vs `app.use`.
10. **Blocking calls freeze everything** in `async def` (`time.sleep`, `requests`, sync pymongo).
11. **Don't shadow the stdlib** with top-level package names (`cmd`, `json`, `types`, `logging`, `email`, `queue`…): the first one on `sys.path` wins. A root `app.py` next to the `app/` package is the same trap, which is why `create_app` lives in `server.py`.
12. **Imports run code.** Module-level `Env()` or client construction executes on import — including for mypy and `play/` scripts. Keep it in `main()`.
13. **Shared error instances** carry the last `__traceback__`; never store request data on them — `with_details()` copies.
14. **Changing an index option isn't idempotent** (`IndexOptionsConflict`); use `collMod`.
15. **aio-pika's first connect isn't robust**; it raises if the broker is down at boot.
16. **Run from the service root** (`python server.py`, `python -m play.x`) so absolute imports resolve.

---

## 4. When to break the mapping

Break it when the Node idiom works around something Python doesn't have:
- arrow-function properties (bound `this`) → plain methods;
- tsyringe + tokens + `reflect-metadata` (types vanish at runtime) → constructor wiring in `server.py`;
- `Partial<T>` constructors with `!` → `@dataclass`;
- controllers that parse `req.params` → FastAPI already did, so the route calls the service.

…or when the Python tool is stronger: validation by annotation (pydantic), ContextVars instead of passing `correlationId`, dependencies that *return* the claims.

…or when the storage changes the rules: repo classes holding a collection handle; no transaction parameter (single-document atomicity); dedupe in the same database as the data because here it's part of correctness.

**Never break it** for what clients and operators see: URLs, envelopes, error codes, the JWT contract, the event envelope, log field names, money and time formats.

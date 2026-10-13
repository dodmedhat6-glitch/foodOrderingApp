# Node → Python mapping

You know `core-service` and `order-service`. This document shows, layer by layer, how each thing you know is written in `analytics-service` — and *why* it sometimes isn't written the same way. Every Python snippet here is from this repo; every Node snippet is from the two Node services.

The rule of thumb: **the architecture transfers unchanged; the idioms do not.** Layers, envelopes, error codes, the outbox, the consumer's ack/nack logic — identical. How a class gets its dependencies, how a request carries the current user, how a value is validated — that's where the language changes the answer.

Contents
1. [Language idioms](#1-language-idioms)
2. [Layer by layer](#2-layer-by-layer) — config · logger · request context · errors · error handler · response envelope · auth · RBAC · request DTOs · response DTOs · entities · repositories · services · controllers · routes · middleware · messaging · event handlers · DI / boot · server lifecycle
3. [Common gotchas when porting](#3-common-gotchas-when-porting)
4. [When to break the mapping](#4-when-to-break-the-mapping)

---

## 1. Language idioms

| TypeScript | Python | Notes |
| --- | --- | --- |
| `class X { constructor(private readonly a: A) {} }` | `class X:` + `def __init__(self, a: A) -> None: self._a = a` | No parameter properties: assign explicitly. `_a` is "private by convention"; nothing enforces it. |
| `class X { a!: number; b!: string }` (data only) | `@dataclass(frozen=True) class X: a: int; b: str` | `frozen=True` ≈ `readonly` on every field. Gives you `__init__`, `__eq__`, `__repr__`. |
| `interface Foo { bar(): Promise<void> }` | `class Foo(Protocol): async def bar(self) -> None: ...` | **Structural**, like TS interfaces: a class satisfies a Protocol by having the methods. No `implements`. |
| `implements IMessageBroker` | *(nothing)* | mypy checks it where the object is *passed* as a `Broker`, not where it is declared. |
| `enum Status { A = "a" }` | `class Status(StrEnum): A = "a"` | `StrEnum` members *are* strings: `Status.A == "a"` is `True`, JSON-serializes as `"a"`. |
| `as const` object of strings | `StrEnum`, or module-level `UPPER = "…"` constants | |
| `type T = A \| B` / `T \| undefined` | `T = A \| B` / `T \| None` | There is one "nothing": `None`. No `undefined`, no `?.` operator. |
| `a?: number` (optional prop) | `a: int \| None = None` | Optional means *has a default*, not *may be missing*. |
| `x ?? y` | `x if x is not None else y` | `x or y` is tempting but also replaces `0`, `""`, `[]`. |
| `Promise<T>` | `async def f() -> T` (returns a coroutine) | Calling an `async def` without `await` does nothing — it builds a coroutine and drops it. |
| `Promise.all([a, b])` | `await asyncio.gather(a, b)` | |
| `setTimeout(fn, ms)` / `await sleep(ms)` | `await asyncio.sleep(sec)` | **Seconds**, not milliseconds. |
| `throw new AppError(…)` / `try/catch (e)` | `raise AppError(…)` / `try/except AppError as e` | `except` matches by class; order matters; bare `except:` also catches Ctrl+C — don't. |
| `throw x` inside `catch` keeping the cause | `raise New(...) from exc` | `from` chains the original into the traceback. |
| arrow-function method `m = () => {}` (keeps `this`) | normal `def m(self)` | `obj.m` is already bound in Python. The Node arrow-property trick has no reason to exist. |
| `export function f` / `import {f} from "./x"` | `def f` / `from pkg.x import f` | Everything top-level is exported. `_name` signals "internal". Imports are absolute from the service root. |
| module-level `export const x = new X()` | module-level `x = X()` | Same semantics (one per process). We avoid it for anything stateful — see §2.19. |
| `import type {X}` (break a cycle) | `if TYPE_CHECKING: from … import X` | Rarely needed if layering is respected. |
| `arr.map(f)` / `.filter(p)` | `[f(x) for x in arr]` / `[x for x in arr if p(x)]` | |
| `new Set(xs)` (read-only) | `frozenset(xs)` | Hashable, immutable. |
| `new Map<K, V>()` | `dict[K, V]` | |
| `JSON.stringify` / `JSON.parse` | `json.dumps` / `json.loads`; pydantic `model_dump(mode="json")` / `model_validate_json` | |
| `new Date()` / `toISOString()` | `datetime.now(UTC)` / `.isoformat()` | **Always pass `UTC`.** `datetime.now()` alone is naive local time. |
| `Number(x)`, `parseInt` | `int(x)` | `int("2.5")` raises; `int(2.5)` truncates. |
| `process.env.X` | `os.environ["X"]` — but only inside `lib/config/env.py` | |
| `decorators` (`@injectable()`, `@IsInt()`) | decorators exist (`@dataclass`, `@router.get`, `@field_validator`) | Python decorators are plain functions applied at definition time; there is no `reflect-metadata`. Validation is declared with **type annotations** on pydantic fields instead of decorators. |
| `any` | `Any` | `mypy --strict` flags leaks the way `noImplicitAny` does. |
| `tsc --noEmit` | `mypy .` | |
| `eslint` / `prettier` | `ruff check .` / `ruff format .` | |
| `package.json` + lockfile | `pyproject.toml` + `uv.lock` | `uv sync --extra dev` ≈ `npm ci`. |
| `node_modules/` | `.venv/` | Per project, gitignored. |
| `tsx src/server.ts` | `python -m cmd.api.main` | `-m` runs a module by its import path, so absolute imports resolve from the service root. |

---

## 2. Layer by layer

### 2.1 Config

**Node** — zod schema, parsed at import, exported singleton (`order-service/src/lib/config/env.ts`):
```ts
const baseSchema = z.object({
    PORT: z.string().default("4000"),
    ACCESS_SECRET: z.string(),
    RABBITMQ_PREFETCH: z.string().default("32"),
});
const parsed = baseSchema.parse(process.env);
export const env = { port: Number(parsed.PORT), rabbit: { prefetch: Number(parsed.RABBITMQ_PREFETCH) } };
```

**Python** — pydantic-settings schema, parsed when `load()` is called (`lib/config/env.py`):
```python
class _Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore", case_sensitive=True)
    PORT: int = 4100
    ACCESS_SECRET: str            # no default = required
    RABBITMQ_PREFETCH: int = 32   # "32" from the env arrives as int 32

def load() -> Env:
    s = _Settings()
    return Env(http=HttpEnv(port=s.PORT), rabbit=RabbitEnv(..., prefetch=s.RABBITMQ_PREFETCH), ...)
```

- Types coerce for you: no `z.string()` + `Number(...)` dance.
- `load()` returns frozen dataclasses (`env.rabbit.prefetch`), the same nested shape as the Node `env` object.
- **Difference:** no import-time parse, no global `env`. `lib/boot` calls `load()` once and hands each component the slice it needs. A module that can `import env` anywhere will eventually read config somewhere surprising; one that has to be *given* it can't.

### 2.2 Logger

**Node** (`lib/logger/logger.ts`):
```ts
logger.info("core-events consumer started", { queue: env.rabbit.queue });
logger.error("handler failed", { eventId, correlationId: req.correlationId });
```

**Python** (`lib/logger/logger.py`):
```python
logger.info("event consumer started", queue=self._options.queue)
from_context().warn("request validation failed", path=request.url.path)  # adds correlationId, userId
```

- Same JSON line: `{"level","message","timestamp"(ms), ...fields}`. Field names stay camelCase so one log search spans the platform.
- Built on stdlib `logging`, so uvicorn's, aio-pika's and pymongo's records come out in the same JSON (`configure()` installs one handler on the root logger).
- **Difference:** Node passes `correlationId` by hand at every call. Python reads it from a ContextVar in `from_context()` — see next section.

### 2.3 Request context — `req.user`, `req.correlationId`

**Node** — augment the request type, mutate the request (`lib/types/express.d.ts`, `correlationId.ts`):
```ts
declare namespace Express { interface Request { correlationId?: string; user?: {...} } }
req.correlationId = id;          // in middleware
someService.call(x, { correlationId: req.correlationId });   // threaded by hand
```

**Python** — ContextVars (`lib/appcontext/context.py`):
```python
_correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)

token = set_correlation_id(cid)  # in CorrelationMiddleware
try:
    await self._app(scope, receive, send_with_header)
finally:
    reset_correlation_id(token)

cid = correlation_id()  # anywhere below, e.g. CoreClient, from_context()
```

- Each asyncio task has its own copy of the context: concurrent requests never see each other's values. It is to async Python what `AsyncLocalStorage` is to Node — the Node services just chose not to use it.
- Only middleware (and the consumer, per message) *sets* these.

### 2.4 Errors

**Node** (`lib/error/AppError.ts`, `app/order/errors.ts`):
```ts
export class AppError extends Error { constructor(message: string, statusCode = 500, ...) }
export const OrderNotFoundError = new AppError("Order not found", 404);
throw OrderNotFoundError;
```

**Python** (`lib/errors/apperror.py`, `app/analytics/errors.py`):
```python
class AppError(Exception):
    def __init__(
        self, code: str, status: int, message: str, details: Mapping[str, Any] | None = None
    ) -> None: ...


ERR_INVALID_DATE_RANGE = AppError("ANALYTICS_INVALID_DATE_RANGE", 400, "`from` must be on or before `to`")
raise ERR_INVALID_DATE_RANGE
raise ERR_DATE_RANGE_TOO_LARGE.with_details(maxDays=366, requestedDays=span)
```

- Same "module-level instance" pattern. **Added:** a stable `code` — clients branch on codes, not on English.
- `with_details()` returns a copy. Never set attributes on a shared `ERR_…` instance: it is shared by every concurrent request.

### 2.5 Error handler

**Node** — four-argument middleware, mounted last (`lib/error/errorHandler.ts`):
```ts
export function errorHandler(err, req, res, _next) {
    const appErr = err instanceof AppError ? err : new AppError(err.message, 500, false);
    return res.status(appErr.statusCode).json({ error: appErr.message, ...appErr.details });
}
app.use(errorHandler);
```

**Python** — exception handlers + a boundary middleware (`lib/errors/handler.py`):
```python
def install(app: FastAPI, logger: Logger) -> None:
    app.add_exception_handler(AppError, on_app_error)
    app.add_exception_handler(RequestValidationError, on_validation_error)  # -> 400 VALIDATION_ERROR
    app.add_exception_handler(StarletteHTTPException, on_http_exception)  # -> 404 / 405


def wrap(app: FastAPI, logger: Logger) -> None:
    app.add_middleware(_ErrorBoundary, logger=logger)  # anything else -> 500
```

- FastAPI raises validation errors *itself*, before your code runs, so they need their own handler to get the platform envelope instead of FastAPI's default `422 {"detail": [...]}`.
- Why a middleware for 500 rather than `add_exception_handler(Exception, ...)`: Starlette runs that one in its outermost layer and **re-raises after responding**, so the crash is logged twice. See the docstring.

### 2.6 Response envelope

**Node** (`lib/http/response.ts`):
```ts
sendSuccess(res, OrderResponseDTO.from(order, items));
```
**Python** (`lib/http/response.py`):
```python
return send_success([RestaurantDayResponse.from_row(row) for row in rows])
```
- Python returns the response instead of writing to `res`. Same `{"success": true, "data": …}` body.

### 2.7 Auth

**Node** — middleware that sets `req.user` (`lib/auth/guard.ts`):
```ts
export function authenticate(req, _res, next) {
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const token = req.cookies?.access_token ?? bearer;
    if (!token) throw NotAuthenticated;
    req.user = verifyAccessToken(token);
    next();
}
router.get("/orders", authenticate, controller.list);
```

**Python** — a callable class used as a FastAPI **dependency** (`lib/auth/middleware.py`):
```python
class Authenticate:
    def __init__(self, access_secret: str) -> None:
        self._secret = access_secret

    async def __call__(self, request: Request) -> Claims:
        token = request.cookies.get("access_token") or _bearer(request)
        if not token:
            raise ERR_UNAUTHENTICATED
        claims = verify_access_token(token, self._secret)
        set_claims(claims)
        return claims
```

- A dependency is FastAPI's middleware-per-route: it runs before the handler, can raise to stop the request, and its **return value** can be injected (`claims: Annotated[Claims, Depends(authenticate)]`).
- Instance with `__call__` = the secret arrives through the constructor, not from a global `env`.
- The wire claim is core's `user_id`; `AccessTokenClaims` (pydantic) validates the decoded token, `Claims` is our shape. Same split as order-service's `CoreAccessTokenClaims` → `JWTPayload`.
- `algorithms=["HS256"]` is pinned. `jsonwebtoken` does this implicitly from the key type; PyJWT requires it — omitting it is an error, which is good.

### 2.8 RBAC

**Node** (`lib/auth/rbac.ts`):
```ts
router.get("/restaurants/:restaurantId/branches/:branchId/orders",
    authenticate, requireRestaurantMember(), rbac({ resource: "orders", action: "read" }), controller.list);
```

**Python** (`lib/rbac/middleware.py`, used in `app/analytics/controller/routes.py`):
```python
@router.get(
    "/restaurants/{restaurantId}/days",
    dependencies=[
        Depends(rbac.require_restaurant_member()),
        Depends(rbac.require(PERM_ANALYTICS_READ)),
    ],
)
```

- Factories returning guards, exactly like `rbac({...})` returns middleware. Both guards depend on `Authenticate`; FastAPI calls it **once** per request and shares the result.
- Permission cache: order-service keeps it in Redis (many replicas share it); here `PermissionsCache` is an in-process dict with TTL and **single-flight** (`asyncio.Lock` per role), because this service has no Redis.
- A malformed `restaurantId` is a 400 here (validated path parameter) vs. a 403 in Node (`positiveIdParam` returns undefined → deny).

### 2.9 Request DTOs

**Node** — class-validator decorators, validated in the controller:
```ts
export class CreateOrderRequestDTO {
    @IsInt() @Min(1) branchId!: number;
    @IsEnum(PaymentMethod) paymentMethod!: PaymentMethod;
}
const input = await validateBody(CreateOrderRequestDTO, req.body);
```

**Python** — pydantic model, validated by FastAPI before the controller (`dto/restaurant_days_request.py`):
```python
class RestaurantDaysQuery(BaseModel):
    from_: date = Field(alias="from")
    to: date

    @field_validator("from_", "to", mode="before")
    @classmethod
    def _strict_iso_day(cls, value: Any) -> Any: ...


async def get_restaurant_days(query: Annotated[RestaurantDaysQuery, Query()]) -> JSONResponse: ...
```

- The **type annotation is the validator**: `date`, `int = Field(gt=0)`, `str = Field(min_length=3)`. Decorators only for custom rules.
- `from` is a keyword → `from_` + `alias`. Aliases are also how snake_case fields map to camelCase JSON.
- Cross-field business rules (`from ≤ to`) stay in the **service**, with the module's own error code — same as Node.

### 2.10 Response DTOs

**Node** (`order.response.dto.ts`):
```ts
export class OrderResponseDTO {
    id!: string; total!: number;
    static from(order: OrderEntity): OrderResponseDTO { const dto = new OrderResponseDTO(); dto.id = order.publicId; ... }
}
```

**Python** (`dto/restaurant_days_response.py`):
```python
class RestaurantDayResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)
    date: str
    orders_count: int          # -> "ordersCount" on the wire
    avg_order_minor: int       # -> "avgOrderMinor"

    @classmethod
    def from_row(cls, row: RestaurantDayRow) -> Self:
        return cls(date=row.day.isoformat(), orders_count=row.orders_count, ...)
```

- `static from` → `@classmethod from_row` (`from` is reserved). `Self` is the return type of "an instance of this class".
- Serialization by alias happens in `send_success` (`jsonable_encoder`).

### 2.11 Entities

**Node** (`order.entity.ts`):
```ts
export class OrderEntity {
    id: number; status: OrderStatus;
    constructor(data: Partial<OrderEntity>) { this.id = data.id!; this.status = data.status!; }
}
```
**Python** (`entity/agg_restaurant_day.py`):
```python
@dataclass(frozen=True)
class AggRestaurantDay:
    restaurant_id: int
    date: str
    orders_count: int
    revenue_sum: int
    updated_at: datetime
```
- No `Partial<…>` + `!` dance: a dataclass constructor requires every field without a default, and mypy checks every call.

### 2.12 Repositories

**Node** — exported functions, `<MODULE>_COLUMNS`, `toEntity(row)`, knex (`order.repo.ts`):
```ts
const ORDER_COLUMNS = ["id", "status", ...];
function toEntity(row: any): OrderEntity { return new OrderEntity({ id: Number(row.id), ... }); }
export async function findOrderByPublicId(publicId: string, conn: Knex) {
    const row = await conn("orders").select(ORDER_COLUMNS).where("public_id", publicId).first();
    return row ? toEntity(row) : undefined;
}
```

**Python** — a class per collection, `_PROJECTION`, `_to_entity(doc)`, pymongo (`agg_restaurant_day_repo.py`):
```python
_PROJECTION = {"_id": 0, "restaurant_id": 1, "date": 1, "orders_count": 1, ...}

def _to_entity(doc: Document) -> AggRestaurantDay:
    return AggRestaurantDay(restaurant_id=int(doc["restaurant_id"]), ...)

class AggRestaurantDayRepo:
    def __init__(self, db: Database) -> None:
        self._col = db[AGG_RESTAURANT_DAY]

    async def find_range(self, restaurant_id: int, start: str, end: str) -> list[AggRestaurantDay]:
        cursor = self._col.find({"restaurant_id": restaurant_id, "date": {"$gte": start, "$lte": end}}, _PROJECTION).sort("date", 1)
        return [_to_entity(doc) async for doc in cursor]

    async def add_placed_order(self, *, restaurant_id: int, day: str, currency: str, total_minor: int) -> None:
        await self._col.update_one(
            {"restaurant_id": restaurant_id, "date": day},
            {"$inc": {"orders_count": 1, "revenue_sum": total_minor},
             "$setOnInsert": {"currency": currency, "delivery_ms_sum": 0, "delivery_ms_count": 0},
             "$set": {"updated_at": datetime.now(UTC)}},
            upsert=True,
        )
```

| knex | pymongo |
| --- | --- |
| `.select(COLUMNS)` | projection dict |
| `.where("a", x).where("b", ">=", y)` | `{"a": x, "b": {"$gte": y}}` |
| `.orderBy("date")` | `.sort("date", 1)` |
| `INSERT … ON CONFLICT DO UPDATE SET n = n + 1` | `update_one(filter, {"$inc": …}, upsert=True)` |
| `ON CONFLICT DO NOTHING` | `insert_one` + `except DuplicateKeyError` |
| migration `CREATE UNIQUE INDEX` | `ensure_indexes()` at boot (`IndexModel(..., unique=True)`) |
| `conn: Knex = db` param for trx | *(no trx — single-document writes are atomic)* |

Why a **class** here when Node uses functions: Node repos import a module-level `db`; ours receive the database in a constructor, because nothing in this service is a global. See §4.

### 2.13 Services

**Node** (`@injectable()` + `@inject(TOKENS.X)`):
```ts
@injectable()
export class OrderPlacementService {
    constructor(@inject(TOKENS.OrderNotifier) private readonly notifier: OrderNotifier) {}
    placeOrder = async (input, requester, ctx): Promise<OrderResponseDTO> => { ... };
}
```
**Python** (`service/analytics_service.py`):
```python
class AnalyticsService:
    def __init__(self, restaurant_days: AggRestaurantDayRepo, max_range_days: int) -> None:
        self._restaurant_days = restaurant_days
        self._max_range_days = max_range_days

    async def get_restaurant_days(self, restaurant_id: int, period: DateRange) -> list[RestaurantDayRow]:
        self._assert_range(period)
        days = await self._restaurant_days.find_range(
            restaurant_id, period.start.isoformat(), period.end.isoformat()
        )
        return [_to_row(day) for day in days]
```
- No decorators, no tokens: the constructor signature *is* the dependency declaration, and `lib/boot` calls it.
- Inputs and outputs are `types.py` dataclasses, never dicts and never DTOs.

### 2.14 Controllers

**Node**:
```ts
list = async (req: Request, res: Response) => {
    const result = await this.service.list(Number(req.params.branchId), parsePaginationQuery(req.query));
    sendPaginated(res, result.items.map(OrderSummaryResponseDTO.from), result.meta);
};
```
**Python** (`controller/analytics_controller.py`):
```python
async def get_restaurant_days(self, restaurant_id: int, query: RestaurantDaysQuery) -> JSONResponse:
    rows = await self._service.get_restaurant_days(restaurant_id, query.to_range())
    return send_success([RestaurantDayResponse.from_row(row) for row in rows])
```
- Receives already-typed, already-validated arguments; no `Number(req.params…)`.
- No `try/except`: errors propagate to the handler, exactly as `express` v5 forwards a rejected promise to `errorHandler`.

### 2.15 Routes

**Node** (`app/order/routes.ts`) — resolve controller from the container at module load:
```ts
export const orderRouter = Router();
const controller = container.resolve<OrderController>(TOKENS.OrderController);
orderRouter.get("/orders/:orderId", authenticate, requireRole(SystemRole.CUSTOMER), controller.get);
```
**Python** (`app/analytics/controller/routes.py`) — a builder that receives what it needs:
```python
def build_router(controller: AnalyticsController, rbac: Rbac) -> APIRouter:
    router = APIRouter()

    @router.get("/restaurants/{restaurantId}/days", dependencies=[...guards...])
    async def get_restaurant_days(
        restaurant_id: Annotated[int, Path(alias="restaurantId", gt=0)],
        query: Annotated[RestaurantDaysQuery, Query()],
    ) -> JSONResponse:
        return await controller.get_restaurant_days(restaurant_id, query)

    return router
```
- FastAPI reads the handler's **signature** to know what to extract and validate. The small inner function is the adapter between that and the controller method.
- Mounted in `lib/boot`: `app.include_router(router, prefix="/api/v1/analytics")` ≈ `routes.use("/", orderRouter)`.

### 2.16 Middleware

**Node**:
```ts
export function correlationId(req, res, next) {
    const id = req.headers["x-correlationid"] || uuidv4();
    req.correlationId = id; res.setHeader("X-CorrelationId", id); next();
}
app.use(correlationId);
```
**Python** — pure ASGI class (`lib/middleware/correlation.py`):
```python
class CorrelationMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        ...
        token = set_correlation_id(cid)
        try:
            await self._app(scope, receive, send_with_header)
        finally:
            reset_correlation_id(token)


app.add_middleware(CorrelationMiddleware)
```
- `next()` becomes "await the wrapped app". Response headers are added by intercepting the `http.response.start` message.
- **Order is inverted:** with `add_middleware`, the **last added is outermost**. Express runs `app.use` calls top to bottom. `lib/boot` adds them innermost-first with a comment showing the request path.
- Per-route middleware is not middleware in FastAPI — it's a dependency (§2.7).

### 2.17 Messaging

**Broker interface** — Node `IMessageBroker` → Python `Broker(Protocol)` (`pkg/messaging/types.py`). Same five operations (connect, close, declareTopology, consume, publish) plus `stop_consuming`/`is_connected`.

**Connection** — `amqp-connection-manager` → `aio_pika.connect_robust`. Both reconnect and replay topology and consumers. One difference: aio-pika only becomes "robust" after the **first** successful connect — a broker that's down at boot raises, so `lib/boot` retries in the background.

**Consumer** (`order-service/src/lib/core-events/consumer.ts` → `lib/coreevents/consumer.py`):
```ts
const fresh = await cacheProvider.trySet(`core-events:dedupe:${envelope.eventId}`, "1", DEDUPE_TTL_SEC);
if (!fresh) { msg.ack(); return; }
const handler = getHandler(envelope.eventType);
try { await handler(envelope.payload, metaOf(envelope)); msg.ack(); }
catch (err) { msg.nack(false); }
```
```python
handler = self._handlers.get(envelope.event_type)
if handler is None:
    await msg.ack()
    return
if not await self._deduper.mark_seen(envelope.event_id):
    await msg.ack()
    return
try:
    await handler(envelope.payload, meta)
except Exception:
    await self._deduper.forget(envelope.event_id)
    await msg.nack(False)
    return
await msg.ack()
```
- Dedupe via a **Protocol** (`EventDeduper`) instead of a Redis call, because `lib/` can't import the Mongo repo that implements it. Why Mongo and not Redis: `system-design.md` §5.
- Two deliberate deviations, explained in the module docstring: handler lookup before dedupe; `forget` on failure so DLQ replays re-apply.
- `msg.ack()` is `await`ed in Python — aio-pika's ack is a coroutine.

**Publisher / outbox** — the outbox lives in the *publisher* (order-service), so there is no Python port of it; the consumer only has to dedupe. The Node side is in `order-service/src/lib/events/`.

### 2.18 Event handlers

**Node** (`lib/core-events/handlers/index.ts`) — side-effecting registration into a global registry:
```ts
registerHandler(CoreEventType.BRANCH_INVALIDATED, onBranchInvalidated);
```
**Python** (`app/analytics/eventhandlers/handlers.py`) — return a dict, hand it to the consumer:
```python
def build_handlers(service: AnalyticsService) -> dict[str, EventHandler]:
    async def on_order_placed(payload: Mapping[str, Any], _meta: EventMeta) -> None:
        event = OrderPlacedPayload.model_validate(payload)
        await service.on_order_placed(OnOrderPlacedInput(...))

    return {OrderEventType.ORDER_PLACED: on_order_placed}
```
- A closure captures `service` — no container lookup inside the handler.
- No global registry: "registered twice" can't happen, so there's no `resetHandlers()` for tests either.

### 2.19 DI / composition

**Node** — tsyringe container (`lib/di/container.ts`), tokens, decorators, `container.resolve` at module load.

**Python** — one function (`lib/boot/boot.py`):
```python
db = await mongo.connect()
analytics_service = AnalyticsService(AggRestaurantDayRepo(db), env.analytics.max_range_days)
analytics_controller = AnalyticsController(analytics_service)
permissions = PermissionsCache(
    CoreRbacClient(CoreClient(http_client, env.core.internal_api_key)), ttl_sec=...
)
rbac = Rbac(Authenticate(env.jwt.access_secret), permissions)
consumer = EventConsumer(
    broker,
    ConsumerOptions(...),
    deduper=EventIDsRepo(db),
    handlers=build_handlers(analytics_service),
    logger=logger,
)
app = _create_app(health=..., analytics=build_analytics_router(analytics_controller, rbac))
```
- Why no container: a Python constructor is already an injection point, there's no `reflect-metadata` to drive autowiring, and ~20 objects fit on one screen. The wiring order *is* the dependency graph — readable, greppable, and a missing dependency is a `TypeError` at boot, not a resolution error at first use.
- Circular dependencies (order ↔ payment in order-service needed `container.resolve` at call time) show up here as "I can't construct A before B" — a design smell surfaced immediately.

### 2.20 Server lifecycle

**Node** (`server.ts`):
```ts
server.listen(env.port, async () => { messageBroker.connect().then(() => startCoreEventsConsumer(messageBroker)); });
process.on("SIGTERM", shutdown);
```
**Python** (`lib/boot/boot.py`):
```python
serving = asyncio.create_task(server.serve())  # GracefulServer(uvicorn.Config(app, ..., log_config=None))
...
await serving
# finally:
await _shutdown(mongo, http_client, broker, consumer, rabbit_retry)
```
- uvicorn is driven **programmatically** inside our event loop (not `uvicorn module:app` from the CLI), so the same `asyncio.run` owns Mongo, RabbitMQ and HTTP and can shut them down in order.
- `GracefulServer` overrides `capture_signals` because stock uvicorn re-raises SIGINT after its own shutdown, which would kill the rest of ours.

---

## 3. Common gotchas when porting

1. **Forgetting `await`.** `repo.find_range(...)` without `await` returns a coroutine object; it's truthy, iterating it fails, and the query never ran. mypy catches the bare-statement case (`unused-coroutine`) and the wrong-type case (`list` expected, `Coroutine` given); at runtime Python only warns "coroutine … was never awaited".
2. **Naive datetimes.** `datetime.now()` is local and naive; comparing it to an aware one raises `TypeError`. Use `datetime.now(UTC)` and `AsyncMongoClient(tz_aware=True)`. Day buckets: `.astimezone(UTC).date()`.
3. **Mutable default arguments.** `def f(x: list[int] = [])` shares one list across calls. Use `None` or `Field(default_factory=list)`.
4. **`round()` is banker's rounding.** `round(2.5) == 2`. For money use integer arithmetic: `(2 * total + count) // (2 * count)` (`analytics_service._div_round_half_up`).
5. **pydantic is lax by default.** `int` accepts `"42"` and `2500.0`; `date` accepts `1760000000`. For contracts that must be exact, use `Field(strict=True)` or a `mode="before"` validator (`payloads.py`, `restaurant_days_request.py`).
6. **`or` is not `??`.** `x or default` replaces `0`, `""`, `[]`, `False`. Use `x if x is not None else default`.
7. **Shared exception instances carry tracebacks.** `raise ERR_X` attaches `__traceback__` to the shared object (keeping the last raise's frames alive). Harmless at our scale; never store request data on it — use `with_details()`.
8. **ContextVars don't flow *up*.** A value set inside a dependency is visible to the handler but not to the middleware that called it after it returns. Set request-wide context in the outermost middleware.
9. **`BaseHTTPMiddleware` and ContextVars.** It runs the app in a separate task; prefer pure ASGI middleware.
10. **Middleware order is reversed** compared to `app.use`. Last `add_middleware` = outermost.
11. **FastAPI's default validation error is 422 `{"detail": …}`.** Without `install()` your clients get a different envelope than from the Node services.
12. **Blocking calls freeze everything.** One `time.sleep(1)` or `requests.get` inside `async def` stops every request and every consumer. Use `asyncio.sleep`, `httpx.AsyncClient`, `AsyncMongoClient`.
13. **Package names that shadow the stdlib.** Our `cmd/` shadows stdlib `cmd`, which breaks `pdb` and `breakpoint()` in this process. Don't name packages `json`, `logging`, `types`, `queue`, `email`, `test`, … at the top level.
14. **Imports run code.** A module-level `env = load()` or `client = AsyncMongoClient()` executes at import — including when mypy, tests or `play/` scripts import the module. Keep side effects in `lib/boot`.
15. **`aio-pika` first connect isn't robust.** Unlike `amqp-connection-manager`, it raises if the broker is down at boot.
16. **Changing an index option isn't idempotent.** `create_index` with a new `expireAfterSeconds` raises `IndexOptionsConflict`. Use `collMod`.
17. **Integer division.** `/` always returns a float in Python 3 (`4000 / 2 == 2000.0`); `//` floors. JSON then sends `2000.0`. Keep money in `//` or the half-up helper.
18. **`-m` and the working directory.** Run everything from the service root with `python -m ...`; running a file by path (`python cmd/api/main.py`) puts `cmd/api/` on `sys.path` and every absolute import fails.

---

## 4. When to break the mapping

Mirroring is the default because it makes the three services readable by one team. But copying an idiom that only exists because of a Node constraint imports the constraint without the reason. Break the mapping when:

- **The Node idiom works around something Python doesn't have.**
  - Arrow-function class properties exist to keep `this` bound. Python methods are bound already → plain `def`.
  - tsyringe + tokens + `reflect-metadata` exist because TS types vanish at runtime. Python constructors and annotations are enough → explicit wiring.
  - `Partial<Entity>` constructors with `!` assertions exist because TS classes don't generate constructors → `@dataclass`.
- **The Python ecosystem has a stronger native tool.**
  - Validation by type annotation (pydantic) instead of decorators (class-validator).
  - ContextVars for request context instead of threading `correlationId` through every signature.
  - FastAPI dependencies for per-route guards — they also *return* values (the claims), which Express middleware can only do by mutating `req`.
- **The storage engine changes the pattern.**
  - Repositories are classes holding a collection handle, not functions importing a global `db` — because nothing here is global.
  - No transactions/`conn` parameter: single-document Mongo writes are atomic, and multi-document transactions need a replica set.
  - Dedupe in the same database as the data (Mongo), not in Redis — because here dedupe is part of correctness (`system-design.md` §5).
- **The requirement is different.** order-service's core-event handlers are idempotent, so its dedupe never needs to "forget"; ours aren't, so it does.

**Never break it** for the things clients and operators see: URL shapes, the envelope, error codes, the JWT contract, the event envelope, log field names, money and time formats. Those are the platform's contracts; the language behind them is an implementation detail.

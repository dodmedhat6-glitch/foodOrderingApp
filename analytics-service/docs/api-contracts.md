# API contracts

Base URL (local): `http://localhost:4100`. All JSON. All responses carry `X-CorrelationId` (echoed if you sent `X-CorrelationId` or `X-Correlation-Id`, minted otherwise).

## Envelopes

```json
{"success": true,  "data": <DTO | DTO[]>}
{"success": false, "error": {"code": "STRING_CODE", "message": "human text", "details": {…}}}
```

`details` appears only when the error carries machine-readable context. Clients branch on `code`, never on `message`.

Conventions: money in **integer minor units** with `currency` (ISO 4217) beside it; days `YYYY-MM-DD` (UTC); timestamps ISO-8601 UTC; JSON keys camelCase.

## Auth

- **Token:** core's access token — cookie `access_token`, or `Authorization: Bearer <token>`. Cookie wins if both are present. HS256 with the platform's `ACCESS_SECRET`.
- **Claims used:** `user_id`, `role`, `restaurantId`, `restaurantRole`.
- **Authorization:** `system_admin` → everything. `restaurant_user` → only their own `restaurantId`, and only if core's permissions for their `restaurantRole` include the endpoint's permission. Any other role → 403.
- **Permission:** `analytics:read`. It must be seeded in core's catalog (`permissions` resource `analytics`, action `read`) and granted to the restaurant roles that should see analytics — a core migration, like `20260927100300_seed_order_service_permissions.ts`.

---

## `GET /health`

No auth. Always 200 while the process can answer.

```json
{"success": true, "data": {"status": "ok", "mongo": "up", "rabbit": "up"}}
```

`status` is `"degraded"` if either dependency is `"down"`.

---

## `GET /api/v1/analytics/restaurants/{restaurantId}/days?from=&to=`

Per-day order activity for one restaurant.

| Param | In | Type | Rules |
| --- | --- | --- | --- |
| `restaurantId` | path | integer | > 0 |
| `from` | query | `YYYY-MM-DD` | required; first UTC day, inclusive |
| `to` | query | `YYYY-MM-DD` | required; last UTC day, inclusive; `from ≤ to`; span ≤ 366 days |

Guards, in order: authenticate → member of `restaurantId` → `analytics:read`.

**200**
```json
{
  "success": true,
  "data": [
    {"date": "2026-10-13", "ordersCount": 2, "revenueMinor": 4000, "currency": "EGP", "avgOrderMinor": 2000}
  ]
}
```

| Field | Meaning |
| --- | --- |
| `date` | UTC day the orders were **placed** |
| `ordersCount` | orders that became `placed` that day (COD at placement, online at payment capture) |
| `revenueMinor` | sum of order `total` (subtotal + delivery fee + service fee), minor units |
| `currency` | the restaurant's currency |
| `avgOrderMinor` | `revenueMinor / ordersCount`, rounded half-up, derived at read time; `0` if `ordersCount` is 0 |

Ordered by `date` ascending. **Sparse:** days without activity are absent, so no data at all is `"data": []`, not an error.

**Errors**

| Status | `code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `from`/`to` missing or not `YYYY-MM-DD`; `restaurantId` not a positive integer. `details.problems[]` lists `{field, message}` |
| 400 | `ANALYTICS_INVALID_DATE_RANGE` | `from` after `to` |
| 400 | `ANALYTICS_DATE_RANGE_TOO_LARGE` | span > `ANALYTICS_MAX_RANGE_DAYS`; `details: {maxDays, requestedDays}` |
| 401 | `UNAUTHENTICATED` | no token, bad signature, expired, malformed claims |
| 403 | `PERMISSION_DENIED` | not a member of the restaurant; role lacks `analytics:read`; role is neither `system_admin` nor `restaurant_user` |
| 502 | `CORE_BAD_RESPONSE` | core answered the permission lookup with a 4xx or an unexpected body |
| 503 | `CORE_UNAVAILABLE` | core unreachable / 5xx after retries, and the role wasn't cached |
| 500 | `INTERNAL_ERROR` | a bug; logged with stack and correlation id |

Note on ordering: authentication runs before parameter validation, so a request with no token and a bad `restaurantId` gets 401, not 400.

---

## Generic errors (any route)

| Status | `code` | When |
| --- | --- | --- |
| 404 | `NOT_FOUND` | no such route |
| 405 | `METHOD_NOT_ALLOWED` | route exists, method doesn't |
| 500 | `INTERNAL_ERROR` | unhandled exception |

---

## Error code index

| Code | Status | Defined in |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | `lib/errors/errors.py` |
| `NOT_FOUND` | 404 | `lib/errors/errors.py` |
| `METHOD_NOT_ALLOWED` | 405 | `lib/errors/errors.py` |
| `INTERNAL_ERROR` | 500 | `lib/errors/errors.py` |
| `UNAUTHENTICATED` | 401 | `lib/auth/errors.py` |
| `PERMISSION_DENIED` | 403 | `lib/auth/errors.py` |
| `CORE_UNAVAILABLE` | 503 | `lib/coreclient/errors.py` |
| `CORE_BAD_RESPONSE` | 502 | `lib/coreclient/errors.py` |
| `ANALYTICS_INVALID_DATE_RANGE` | 400 | `app/analytics/errors.py` |
| `ANALYTICS_DATE_RANGE_TOO_LARGE` | 400 | `app/analytics/errors.py` |
| `ANALYTICS_INVALID_EVENT_PAYLOAD` | (422) | `app/analytics/errors.py` — never an HTTP response; logged when an event is dead-lettered |

---

## Inbound event contract

### Topology

| | |
| --- | --- |
| Exchange | `order.events` — topic, durable; declared by order-service's worker |
| Queue | `analytics-service.order-events` — durable, `x-dead-letter-exchange: analytics-service.order-events.dlx` |
| Bindings | `order.#`, `payment.#` |
| DLQ | `analytics-service.order-events.dlq`, bound `#` on the DLX (original routing key kept) |
| Delivery | at-least-once, persistent, manual ack, prefetch 32 |

### Envelope (every event)

```json
{
  "eventId": "8957a98e-7a94-4f69-8f81-19f935cc56d0",
  "eventType": "order.placed",
  "occurredAt": "2026-10-13T18:50:01.915Z",
  "entityType": "order",
  "entityId": "0199e0b4-…",
  "payload": { … }
}
```

`eventId` and `eventType` are required; `eventType` must equal the routing key. `correlationId` is accepted if present. Defined publisher-side in `order-service/src/lib/events/types.ts` (`OutboundEventEnvelope`).

### `order.placed`

```json
{
  "orderId": "0199e0b4-…",          "region": "eg",       "countryCode": "EG",
  "restaurantId": 42,               "branchId": 420,      "customerId": 1001,
  "status": "placed",               "paymentMethod": "cod",
  "subtotal": 500, "deliveryFee": 1500, "serviceFee": 500, "total": 2500,
  "currency": "EGP",
  "items": [{"productId": 1, "quantity": 1, "unitPriceMinor": 500, "lineTotal": 500}],
  "placedAt": "2026-10-13T18:50:01.915Z"
}
```

Validated by `app/analytics/eventhandlers/payloads.py`: `restaurantId`, `branchId` > 0; money fields non-negative integers (`total` strict — `2500.0` is rejected); `currency` 3 letters; `placedAt` must carry a UTC offset. Unknown extra fields are ignored. Publisher: `order-service/src/app/order/events.ts`.

Effect: `agg_restaurant_day[(restaurantId, utc_date(placedAt))]` ← `orders_count += 1`, `revenue_sum += total`.

### Message outcomes

| Condition | Outcome |
| --- | --- |
| body not a valid envelope | nack → DLQ |
| routing key ≠ `eventType` | nack → DLQ |
| no handler for `eventType` | ack (logged) |
| `eventId` seen in the last 7 days | ack (logged "duplicate") |
| payload invalid / handler error | `eventId` forgotten, nack → DLQ |
| success | ack |

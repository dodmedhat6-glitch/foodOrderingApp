# Module: Delivery & Agent (`app/delivery-agent`) — Business Logic & Implementation Plan

Owns writes to: `deliveries`, `delivery_assignment_attempts`, `agent_presence`,
`agent_earnings`. Depends on `app/orders` (reads order/branch/address info; calls
`applyDeliveryStatusSideEffect` on it) and `app/payments` (calls `recordCodCollection` at
delivery time — see `04-modules/payments.md` §4).

**Build this module third**, after `orders` and `payments` exist, since assignment is triggered
by an order reaching `READY_FOR_PICKUP` and delivery completion triggers a payment-ledger effect.

## 1. Assignment strategy

**Automatic (default)**: triggered internally when `orders.service.ts` transitions an order to
`READY_FOR_PICKUP` (`04-modules/orders.md` §1/§3). Algorithm:

1. Query Redis `agents:geo:{region}` (`GEOSEARCH` centered on the branch's lat/lng, radius
   configurable) for online agents, ordered by distance.
2. Filter out agents already at their concurrent-task limit (configurable — read from
   `deliveries WHERE current_agent_id = X AND status IN ('ASSIGNED','PICKED_UP')`, or better,
   keep a live per-agent active-task counter in Redis to avoid a DB round-trip on every
   assignment attempt — **recommend the Redis counter**, incremented on `ASSIGNED`, decremented on
   `DELIVERED`/`FAILED`, since assignment is on a semi-hot path and this avoids an extra query).
3. Offer to the nearest eligible agent: insert a `delivery_assignment_attempts` row
   (`outcome = NULL`), set `deliveries.current_agent_id` **provisionally** (or leave `NULL` until
   `ACCEPT` — **recommend leaving it `NULL` until accepted**, so `GET /agents/tasks` for *other*
   agents doesn't need to filter out "offered but not yet accepted" tasks from their own view by
   accident), increment `deliveries.attempt_count`.
4. The offered agent has a configured response window (TBD exact seconds — infra/product
   decision) to `ACCEPT`/`REJECT` via `PATCH /deliveries/{deliveryId}/status`. A background
   sweep (or a Redis key with TTL + expiry callback / a scheduled job) marks attempts that time
   out as `outcome = TIMED_OUT` and immediately triggers step 3 again with the next-nearest agent.
5. If no eligible agent exists at all (empty geo-search result), `deliveries.status` stays
   `UNASSIGNED` and the job retries on a backoff (not a hard failure to the restaurant — the order
   remains `READY_FOR_PICKUP` and visible on the dashboard as "awaiting rider").

**Manual override**: `POST /deliveries/assign/{orderId}` with an explicit `agentId`
(admin/restaurant-triggered) skips the geo-search and directly creates the offer to that agent —
same acceptance flow from step 4 onward.

## 2. Reassignment & retry limits

`POST /deliveries/reassign/{orderId}` (called automatically on `REJECTED`/`TIMED_OUT`, or
manually by admin/restaurant): re-runs the assignment algorithm (§1 steps 1–3) against the next
candidate, **excluding agents who already have an `outcome` on this order's
`delivery_assignment_attempts`** (don't re-offer to someone who already rejected it). Enforces a
configured **max total attempts** (e.g. 5 — exact number TBD, a product/ops decision, not an
architectural one): once `deliveries.attempt_count` reaches the max, set
`deliveries.status = FAILED`, `failed_at = now()`, and surface this prominently on the admin
dashboard — this is exactly the "limited retries" requirement from the given endpoint list, made
concrete.

## 3. Delivery status lifecycle (agent-driven)

```
UNASSIGNED ──(offer accepted)──► ASSIGNED ──(agent confirms pickup)──► PICKED_UP
                                                                            │
                                                                (agent confirms delivery)
                                                                            ▼
                                                                       DELIVERED  [terminal]

(any outstanding offer, not the delivery's own status) REJECTED/TIMED_OUT → triggers reassignment (§2)
attempt_count exceeds max → FAILED [terminal]
```

`PATCH /deliveries/{deliveryId}/status` verb table:

| `action` | Legal precondition | Result |
|---|---|---|
| `ACCEPT` | caller has an outstanding (`outcome IS NULL`) attempt row for this order | sets that attempt's `outcome = ACCEPTED`, `responded_at`; sets `deliveries.current_agent_id = caller`, `status = ASSIGNED`, `assigned_at`; **side effect**: `orders.status → OUT_FOR_DELIVERY` (`applyDeliveryStatusSideEffect`) |
| `REJECT` | same as above | sets that attempt's `outcome = REJECTED`, `responded_at`; triggers reassignment (§2), asynchronously (after this request returns `200`, not blocking the agent's own response) |
| `PICKUP` | caller is `deliveries.current_agent_id`, status `ASSIGNED` | `status = PICKED_UP`, `picked_up_at` |
| `DELIVER` | caller is `deliveries.current_agent_id`, status `PICKED_UP` | `status = DELIVERED`, `delivered_at`; **side effects, same DB transaction**: `orders.status → DELIVERED`; insert `agent_earnings` row; call `paymentsService` — for COD, record cash collection (`04-modules/payments.md` §4); for both COD and ONLINE, run the `ORDER_PAYMENT` balance credit + `COMMISSION` ledger entries (`04-modules/payments.md` §2–§3) |

Any other `(action, status)` pair → `409`.

## 4. Agent earnings calculation

A flat/configured per-delivery earning amount (rate TBD — not specified in source material;
model as a lookup, e.g. per-region flat fee or a percentage of `deliveryFeeMinor`, configurable,
never hardcoded) is computed and inserted into `agent_earnings` at the same moment as the
`DELIVER` action (§3), guarded by the `idx_earnings_agent_earned`
unique constraint on `order_id` so a retried/duplicate `DELIVER` call can never double-credit an
agent (defense in depth alongside the state-machine guard that `DELIVER` is illegal once already
`DELIVERED`).

## 5. Presence & real-time location

- `POST /agents/presence/online` / `/offline`: low-frequency, safe to write straight to
  `agent_presence` (Postgres) synchronously, and update the Redis geo-set
  membership (`agents:geo:{region}`) in the same request.
- `POST /agents/presence/ping`: **high-frequency** (called every few seconds by the agent app
  while online). Writes Redis synchronously every time (`GEOADD` + refresh
  `agents:lastseen:{agentId}` TTL). Writes to the `agent_presence` Postgres table are **throttled**
  (e.g. at most once per 30s per agent — exact cadence TBD, see `02-database-design.md` §7.3) to
  avoid write amplification on a high-write-already service; a simple approach is to check
  `now() - agent_presence.updated_at > threshold` before issuing the Postgres write, using the
  Redis last-seen value as the cheap read to decide, so most pings never touch Postgres at all.
- `GET /agents/tasks` and the assignment algorithm (§1) read **Redis** for live location, never
  the `agent_presence` Postgres table — that table exists purely as a durability snapshot / audit
  trail (e.g. "was this agent online at time X" for support investigations), not a query path.

## 6. Implementation plan (in order)

1. **Migrations**: `deliveries`, `delivery_assignment_attempts`, `agent_presence`,
   `agent_earnings` tables + enums (`delivery_status`, `assignment_outcome`, `agent_status`) +
   indexes from `02-database-design.md` §3.5–§3.7, §3.9.
2. **`pkg/geo`**: pure lat/lng distance helpers if needed beyond what Redis `GEOSEARCH` already
   provides (likely minimal — Redis does the heavy lifting).
3. **`lib/redis-geo/init.ts`** (or extend the existing Redis wiring from `05-folder-structure.md`
   §2.2) — the geo-set key helpers (`agents:geo:{region}` naming, TTL policy for stale agents).
4. **Entities**: `entity/delivery.entity.ts`, `entity/delivery-assignment-attempt.entity.ts`,
   `entity/agent-presence.entity.ts`, `entity/agent-earning.entity.ts`.
5. **Repository**: `repository/delivery-agent.repository.ts` — `insertDelivery` (created
   alongside the order, or lazily on first `MARK_READY` — **recommend creating the `deliveries`
   row at order-creation time**, `status = UNASSIGNED`, so there's never a nullable "no delivery
   row yet" state to handle in queries), `createAssignmentAttempt`, `resolveAttemptOutcome`,
   `updateDeliveryStatus`, `findTasksForAgent`, `insertAgentEarning`, `upsertAgentPresence`.
6. **Services**: `service/assignment.service.ts` (§1–§2), `service/delivery-status.service.ts`
   (§3), `service/presence.service.ts` (§5), `service/earnings.service.ts` (§4, mostly read-side).
7. **DTOs**: `dto/request/update-delivery-status.dto.ts`, `dto/request/ping.dto.ts`,
   `dto/response/delivery.response-dto.ts`, `dto/response/agent-task.response-dto.ts`,
   `dto/response/agent-earning.response-dto.ts`.
8. **Controller**: `controller/delivery.controller.ts`, `controller/agents.controller.ts` (two
   controllers, one module — the endpoint list itself splits `/deliveries/*` from `/agents/*`;
   keep that split at the controller level for readability even though the service/repository
   layer is shared).
9. **Routes**: mount `POST /deliveries/assign/:orderId`, `POST /deliveries/reassign/:orderId`,
   `PATCH /deliveries/:deliveryId/status`, `POST /agents/presence/{online,offline,ping}`,
   `GET /agents/tasks`, `GET /agents/earnings`; mount in `src/routes.ts` in the same commit.
10. Unit tests: assignment eligibility filtering, retry-limit enforcement (§2), the delivery
    status verb table (§3), the earnings-uniqueness guard (§4).
11. Wire `applyDeliveryStatusSideEffect` (called on `app/orders`) and the calls into
    `app/payments` (§3's `DELIVER` side effects) — these are the two cross-module integration
    points to integration-test explicitly (a `DELIVER` action should be verifiable end-to-end to
    move `orders.status`, credit `restaurant_balances`, and insert `agent_earnings` all in one
    transaction).

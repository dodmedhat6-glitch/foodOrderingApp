# Business Logic — Deliveries Module

Owner module: `app/delivery/`

Finds an agent for an order while it is still cooking (dispatch opens at
`preparing`), carries it through the
agent-facing transitions, and runs money settlement on `delivered`.

> **There is no `deliveries` table and no `DeliveryEntity`.** A delivery is a
> phase of an order, not an entity beside it — see `docs/database-design.md` §3.7
> for the full argument. Everything below reads and writes `orders`.

---

## 1. Status model

The delivery lifecycle is a stretch of the order status machine
(`docs/business-logic/orders.md` §2), not a parallel one:

```
preparing ──(agent claims early)──► preparing + agent ──(kitchen: ready)──► assigned
    │                                                                         ▲
    └──(kitchen: ready, nobody claimed)──► ready ──(agent claims)─────────────┘

assigned ──► picked ──► delivered (terminal)
assigned ──(unclaim)──► ready        preparing + agent ──(unclaim)──► preparing
```

**Dispatch opens at `preparing`, not `ready`.** The agent drives to the branch
while the food cooks, so the food waits for the courier less often. A claim on a
`preparing` order attaches the agent (`delivery_agent_id`, `assigned_at`) and
leaves the status alone; the kitchen's `ready` write promotes it to `assigned`
in the same transaction, so `ready`-with-an-agent is never committed.
`picked` is still reachable only from `assigned` — an early agent waits at the
counter until the food is up.

| Order status | Delivery meaning                                   | Who writes          |
| ------------ | -------------------------------------------------- | ------------------- |
| `preparing`  | Cooking; offered to agents, may already hold one    | restaurant          |
| `ready`      | Food is up and nobody has claimed it yet            | restaurant          |
| `assigned`   | Food is up and an agent holds it                    | agent (claim) / system (promotion on `ready`) |
| `picked`     | Agent confirmed pickup at the branch                | agent               |
| `delivered`  | Handoff confirmed — triggers settlement (§5)        | agent → terminal    |
| `cancelled`  | Order cancelled before pickup; agent released       | customer / restaurant / system |

**No agent-accept step.** The draft had `assigned → accepted`; with
offer-and-claim the claim *is* the assignment, so there is one state where there
were two, and no accept timeout to manage.

**No `rejected` delivery state.** An agent who does not want an offer simply does
not claim it. An agent who claims and then changes their mind unclaims, which
returns the order to `ready` and re-offers it.

---

## 2. Dispatch: offer to the top K, first claim wins

### Why this shape

The alternative — assign one agent, wait 30s for an accept, mark rejected, try
the next — costs up to three sequential 30-second windows before the third agent
ever hears about the order, and needs a durable row per attempt just to hold a
pending offer. Broadcasting to the K nearest and letting the first claim win gets
the order moving in one agent-reaction-time and needs no row at all, because
Postgres arbitrates the race. The cost is that K−1 agents see an offer that
evaporates — the normal experience on every dispatch platform.

### Candidate scan

Pickup coordinates come from the **branch projection** (`core:branch:<branchId>`,
60s TTL, Phase 0), which already carries `lat` / `lng`. No new core endpoint, no
new column on `orders`, no new cache key.

One call into `IPresenceStore.findNearestAgents(region, lat, lng, radiusM, limit)`:

1. `GEOSEARCH presence:geo:<region> FROMLONLAT <lng> <lat> BYRADIUS
   ASSIGNMENT_RADIUS_METERS M ASC COUNT <k>` — Redis returns the nearest
   candidates already sorted by distance. There is no scan and no sort in
   application code.
2. Pipeline-read the candidates' `presence:meta` keys in **one** round trip.
   A missing key means the agent has gone stale (their TTL lapsed —
   `PRESENCE_STALE_SEC`, **default 300**, the agreed 5-minute rule): drop them,
   and `ZREM` the tombstone while we are here.
3. Drop anyone whose meta hash names an active order.

**There is no Postgres fallback.** Presence exists only in Redis
(`docs/database-design.md` §3.8), so a Redis outage stops dispatch rather than
degrading it. Orders stay `ready`, the sweep picks them up when Redis returns,
and no status ever lies to the customer in the meantime.

### Offer

Emit `task.offered` on `agent:<id>` to all K simultaneously, carrying the pickup
and dropoff summary, the earning estimate, and an `expiresAt`
(`ASSIGNMENT_OFFER_TTL_SEC`, default 45).

### Claim — `POST /api/orders/{publicId}/claim`

The race is resolved by one conditional UPDATE, not by a lock:

```sql
UPDATE orders
SET status = CASE WHEN status='ready' THEN 'assigned' ELSE status END,
    delivery_agent_id=?, assigned_at=NOW(), updated_at=NOW()
WHERE id=? AND created_at=? AND status IN ('preparing','ready')
  AND delivery_agent_id IS NULL;
```

- 1 row → winner. Write the active order onto the agent's `presence:meta` hash
  (so pings can fan out to the customer without querying `orders`, and so the
  candidate scan sees them as busy), emit `task.assigned` to the winner,
  `task.taken` to the others, and `order.status_changed` to the customer and
  branch.
- 0 rows → 409 `OrderAlreadyAssigned`. The agent's client clears the offer.

Pre-check that the claiming agent holds no other active order
(`status IN ('preparing','ready','assigned','picked')`, backed by
`idx_orders_delivery_agent_id_status`) → 409 `AgentInActiveDelivery`.

### The sweep is the entry point

`app/delivery/jobs.ts`, interval `ASSIGNMENT_SWEEP_SEC` (default 15),
Redis lock per region. It scans `preparing` and `ready` orders with
`delivery_agent_id IS NULL` (`ready` first, then oldest) via the partial index
`idx_orders_status_created_at`, and offers each one.

A post-commit hook on a transition fires **once**, at the moment a human
presses a button. If no agent is online in that instant the order sits
unclaimed forever. So the `preparing` and `ready` transitions only *nudge* the
sweep awake to keep the common case sub-second; correctness lives in the sweep.

Each re-offer widens the radius by `ASSIGNMENT_RADIUS_ESCALATION` (default 2),
capped at `ASSIGNMENT_RADIUS_MAX_METERS`. After `MAX_ASSIGNMENT_ATTEMPTS`
(default 3, counted in `assign:attempts:<orderId>`, TTL = the order's life) the
sweep emits `assignment.stalled` to the admin channel and leaves the order
`ready`. A stalled order stays visible; it is never auto-cancelled.

A `preparing` order never stalls — nobody being free while the food cooks is
normal. It keeps being offered at the widest radius, and reaching `ready`
unclaimed resets its rounds so it gets the full escalation before an alert.

---

## 3. The freshness cutoff, and what it actually buys

`PRESENCE_STALE_SEC = 300` is the agreed rule: only agents seen in the last five
minutes are offered work. Two things worth being honest about.

**Five minutes of staleness is a lot of distance.** Agents ping every 30s, so 300s
tolerates nine missed pings — generous, and deliberately so: a phone in a tunnel
or on a flaky mobile network should not drop out of dispatch. But a moving agent
covers 2–3 km in five minutes in city traffic, so a position that old can place
them outside the 5 km radius they appear to be inside, or inside one they have
left.

Mechanically the cutoff is the `presence:meta` key's TTL, not a comparison in
code — so "fresh" means "Redis still has the key", and tuning the rule is
changing one env var rather than auditing every query that filters on it.

**The radius filter is therefore a heuristic, and the claim is the real filter.**
An agent who has driven away sees an offer that no longer suits them and does not
claim it; one who has driven closer claims it. That is exactly why offer-and-claim
tolerates stale coordinates better than push-assignment does — a wrong guess costs
a wasted notification, not a 30-second stall on an agent who cannot take the job.

**Consequence for tuning:** widen `PRESENCE_STALE_SEC` before you widen
`ASSIGNMENT_RADIUS_METERS`. A stale-but-close agent is a better candidate than a
fresh-but-distant one, and the ordering already prefers the close one.

---

## 4. Agent transitions — the existing order endpoint

`PATCH /api/orders/{publicId}/status` with `OrderActor.AGENT`. There is no
`/deliveries/{id}/status`.

| From       | To          | Actor | Guard                                   |
| ---------- | ----------- | ----- | --------------------------------------- |
| `assigned` | `picked`    | agent | `order.delivery_agent_id === userId`    |
| `picked`   | `delivered` | agent | same, plus settlement (§5)              |

Anything else → 409 from `assertTransition`. The ownership check lives in the
service and reads the order row — never the request body. An agent acting on
another agent's order is 403, not 404: they were told about this order by an
offer, so its existence is not a secret.

### Unclaim — `POST /api/orders/{publicId}/unclaim`

Allowed only from `assigned`. Clears `delivery_agent_id`, returns the order to
`ready`, clears the active order from `presence:meta`, and lets the next sweep
re-offer. From `picked`
it is 409 — the food is in the agent's bag, and handing it back is an exceptions
flow, not a delivery flow.

---

## 5. Settlement on `delivered`

One transaction. Order of operations is fixed because it is money
(`docs/business-logic/restaurant-finance.md` §7):

1. `SELECT … FOR UPDATE` the `restaurant_balances` row for `(restaurant_id, currency)`.
2. `commission = floor(subtotal × branch.commissionRate)`; stamp `orders.commission`.
3. **COD** → flip the pending `transactions(cod_collection)` to `succeeded`.
   **Online** → assert the `charge` is already `succeeded` (it must be — the order
   could not have left `pending_payment` otherwise).
4. Insert `transactions(type='commission', method='system', status='succeeded',
   amount=commission, src=ownerId, dst=NULL)` through `createTransactionIfNew`
   (`ON CONFLICT DO NOTHING` on `idempotency_key` — **never** try/catch, which
   would abort the rest of the transaction; CLAUDE.md §8).
5. `restaurant_balances.balance += subtotal − commission`.
6. Insert `agent_earnings` — `ON CONFLICT (order_id) DO NOTHING`. Amount is
   `AGENT_EARNING_BASE_MINOR + AGENT_EARNING_PER_KM_MINOR × km`, stamped at
   settlement so a later rate change cannot restate last month's earnings.
7. Flip `orders` to `delivered`, addressing `(id, created_at)` so the write prunes
   to one partition.
8. Commit. **Then** clear the active order from the agent's `presence:meta` and
   publish WebSocket events. Nothing after the commit may fail the request.

Every write in steps 4–7 is idempotent, so a replayed `delivered` is a no-op
rather than a double payout. That is the property to test, not just the happy path.

---

## 6. Cancellation while in delivery

- Cancelled while `assigned` → clear `delivery_agent_id`, clear the active order
  from the agent's `presence:meta`, emit `task.cancelled` on `agent:<id>`.
- Cancelled after `picked` → forbidden by `assertTransition`. The food is already
  with the agent; recovering it is an exceptions flow that is out of scope
  (CLAUDE.md §13).

---

## 7. RBAC

| Action                                             | Who                                    |
| -------------------------------------------------- | -------------------------------------- |
| `POST /orders/{publicId}/claim`                     | `delivery_agent` (ownership by claim)  |
| `POST /orders/{publicId}/unclaim`                   | the assigned `delivery_agent`          |
| `PATCH /orders/{publicId}/status` (picked/delivered)| the assigned `delivery_agent`          |
| `POST /orders/{publicId}/assign` (manual override)  | `system_admin` (by role)               |

Agents are not RBAC-permissioned for their own order — ownership is checked in
the service against `orders.delivery_agent_id`. The admin force-assign is gated by
role rather than by a permission, so this module adds nothing to core's catalog.

---

## 8. Invariants

1. An order has at most one agent: enforced by the conditional UPDATE, not by
   application checks.
2. An agent has at most one order in `('assigned','picked')`.
3. `status='delivered'` ⟹ exactly one `agent_earnings` row for that `order_id`
   (unique constraint).
4. `status='delivered'` ⟹ `restaurant_balances` was incremented in the same
   transaction.
5. An agent whose `presence:meta` names an active order has one in `orders`. The
   reverse may lag after a Redis failure — the DB is the truth, and the claim's
   own pre-check reads it rather than the hash.
6. An order never leaves `ready` because dispatch gave up; it stalls visibly.

---

## 9. Performance notes

- Assignment is two Redis round trips (`GEOSEARCH`, then one pipelined meta read)
  and zero Postgres queries. The candidate set is never sorted or filtered by
  distance in application code — `GEOSEARCH ... ASC COUNT k` does both.
- The branch projections for a sweep batch are fetched with one `getMany` (MGET),
  never one `get` per order — a per-key cache read in a loop is a bug, exactly
  like an N+1 query (CLAUDE.md §8).
- `idx_orders_delivery_agent_id_status` (partial) covers the agent task list;
  `idx_orders_status_created_at` (partial) covers the sweep. Both exist since
  Phase 1.
- Settlement holds a `FOR UPDATE` row lock on one restaurant's balance. It is the
  one serialization point in the phase, and it is scoped to a single restaurant,
  so contention is bounded by one restaurant's delivery rate.
- **No provider or upstream call is ever made inside the settlement transaction.**

---

## 10. WebSocket events emitted

| Event                  | Channel                        | Payload                                             |
| ---------------------- | ------------------------------ | --------------------------------------------------- |
| `task.offered`         | `agent:<id>` (×K)              | `DeliveryTaskResponseDTO` + `expiresAt`             |
| `task.assigned`        | `agent:<id>` (winner)          | `DeliveryTaskResponseDTO`                           |
| `task.taken`           | `agent:<id>` (losers)          | `{ orderPublicId }`                                 |
| `task.cancelled`       | `agent:<id>`                   | `{ orderPublicId, reason }`                         |
| `order.status_changed` | `customer:<id>`, `branch:<id>` | `{ orderPublicId, status, ts }`                      |
| `assignment.stalled`   | admin channel                  | `{ orderPublicId, branchId, attempts }`             |

Published after commit, through `lib/websocket/publisher.ts`, in the service that
made the transition — not in a later wiring phase.

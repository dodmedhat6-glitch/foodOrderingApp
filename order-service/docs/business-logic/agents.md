# Business Logic — Agents Module

Owner module: `app/agent/`

Covers agent presence (online / offline / ping), the agent's task list, and
earnings reads.

The transitions an agent performs on an order — claim, picked, delivered — live
in the **Deliveries** module (`docs/business-logic/deliveries.md`), because they
write `orders`. This module never writes an order; the delivery module never
writes presence.

---

## 1. Presence model — Redis only

**There is no `agent_presence` table.** Presence answers one question — which
agents are near this branch *right now* — and the answer is worthless once it is
five minutes old. A durable row describing an expired position is a cache with a
migration attached. See `docs/database-design.md` §3.8.

Two keys per region:

| Key                                | Type       | TTL                  | Holds                                                     |
| ---------------------------------- | ---------- | -------------------- | --------------------------------------------------------- |
| `presence:geo:<region>`            | GEO (ZSET) | none (swept)         | every known agent's last coordinates                       |
| `presence:meta:<region>:<agentId>` | HASH       | `PRESENCE_STALE_SEC` | `lastSeenAt`, `lat`, `lng`, and the active order while held |

**The meta key's TTL is the five-minute rule.** A GEO member cannot expire on its
own (ZSET members never carry a TTL), so liveness is expressed by the one key
that can. An agent who stops pinging has their meta key vanish after
`PRESENCE_STALE_SEC`; their geo entry becomes a tombstone that the candidate
filter skips and the sweep removes. **Nothing in application code compares
timestamps** — Redis expiry does the work.

**There is no `presence:busy` set.** The active order is a field on the meta
hash, written by the same command that refreshes liveness, so busy-ness cannot
drift out of sync with it. It was never the real guard anyway: exclusivity is the
conditional UPDATE on `orders`, the only check that survives a Redis flush.

**Losing all of it is a supported state.** Every agent re-registers on their next
ping, at most 30 seconds away. What must survive a restart — who delivered what,
and what they earned — is in `orders` and `agent_earnings`, both durable.

`app/agent/jobs.ts` (`PRESENCE_SWEEP_SEC`, default 60, Redis lock per
region) removes geo tombstones so the set does not grow without bound. It is
housekeeping, not correctness: a tombstone is already invisible to dispatch.

---

## 2. Endpoints

| Endpoint                           | Auth            |
| ---------------------------------- | --------------- |
| `POST /api/agents/presence/online` | `delivery_agent`|
| `POST /api/agents/presence/offline`| `delivery_agent`|
| `POST /api/agents/presence/ping`   | `delivery_agent`|
| `GET /api/agents/tasks?status=`    | `delivery_agent`|
| `GET /api/agents/earnings?from=&to=` | `delivery_agent`|

Standard `authenticate` guard; the agent id is `req.user.userId`, never a path
or body parameter.

### POST /agents/presence/online

```ts
class PresenceRequestDTO {
  lat!: number;   // -90 .. 90
  lng!: number;   // -180 .. 180
}
```

Bounds are validated. A transposed lat/lng pair silently poisons the geo set and
produces offers from the wrong continent, so this is a `class-validator` rule,
not a comment.

- `GEOADD presence:geo:<region> <lng> <lat> <agentId>` — note the argument order,
  longitude first. Transposing it is the single easiest way to break dispatch,
  which is the other reason the DTO bounds-checks both values.
- Write `presence:meta:<region>:<agentId>` with `lastSeenAt`, `lat`, `lng` and a
  `PRESENCE_STALE_SEC` TTL.
- Going online does **not** clear an active order field: if the agent crashed
  mid-delivery and came back, the order is still theirs. The meta hash is
  repopulated from `orders` on the next task read, and the claim pre-check reads
  `orders` directly, so the truth reasserts itself either way.

The same DTO serves `ping`.

### POST /agents/presence/offline

- Read the agent's active order **from `orders`**, not from Redis — this decision
  releases work, so it reads the durable copy:
  - `assigned` → unclaim it (`delivery.service`), returning it to `ready` for the
    sweep to re-offer.
  - `picked` → **409 `AgentInActiveDelivery`.** The food is in their bag.
  - none → proceed.
- `ZREM presence:geo:<region> <agentId>` and `DEL presence:meta:<region>:<agentId>`.

Offline is therefore the one presence operation with no durable trace, and it
needs none: not being in the geo set is indistinguishable from never having been
there, which is exactly right.

### POST /agents/presence/ping

- 409 `NotOnline` if the meta key is absent — which covers both "never went
  online" and "went online six minutes ago and stopped pinging". An agent cannot
  drift back into dispatch by pinging; they must re-announce with `online`.
- `GEOADD` the new coordinates and refresh the meta hash, resetting its TTL. The
  refresh *is* the liveness signal.
- If the meta hash carries an active order, fan the position out to
  `customer:<customerId>` as `delivery.position`. **The active order is read from
  the hash, never from `orders`** — a ping every 30s from every online agent must
  not become a query per ping.

Cadence: every 30s while moving. The freshness cutoff is the meta key's TTL,
`PRESENCE_STALE_SEC` (default **300** — the agreed 5-minute rule), so nine
consecutive missed pings are tolerated before an agent stops receiving offers.
See `docs/business-logic/deliveries.md` §3 for why that number is lenient on
purpose and why the radius filter is a heuristic rather than a guarantee.

---

## 3. GET /agents/tasks?status=

Orders where `delivery_agent_id = me`, optionally filtered to
`assigned | picked | delivered`.

- Cursor pagination on `assigned_at DESC` (never offset — CLAUDE.md §9).
- Backed by the partial `idx_orders_delivery_agent_id_status`.
- Items are batch-fetched with a single `whereIn('order_id', ids)`; a per-order
  item query is a bug.
- Response `DeliveryTaskResponseDTO[]` — pickup summary (branch name, address,
  coords), dropoff summary (`delivery_address_text_snapshot`, coords), order
  totals, item count. **No `deliveryId`** — the handle is the order's `publicId`.
- `withCache(5)` user-scoped, invalidated explicitly on every transition that
  changes the agent's task set (claim, unclaim, picked, delivered, cancellation).

---

## 4. GET /agents/earnings?from=&to=

List plus `SUM` over `agent_earnings` in the range. Defaults: `from` = first day
of the current month, `to` = now.

```ts
class AgentEarningsResponseDTO {
  range!: { from: string; to: string };
  totals!: { count: number; sum: number; currency: string };
  items!: Array<{
    orderPublicId: string;
    amount: number;      // minor units
    currency: string;
    earnedAt: string;    // ISO 8601 UTC
  }>;
  nextCursor!: string | null;
}
```

- Backed by `idx_agent_earnings_agent_earned_at`.
- `orderPublicId` is read from the denormalized `agent_earnings.order_public_id`,
  so this endpoint **never touches `orders`** — no cross-partition fan-out, and
  the list stays readable after archival moves the order rows out of the hot
  cluster.
- Ranges entirely in prior years route to the archive cluster (Phase 5).

---

## 5. Auto-assignment integration

The delivery module's assignment service calls
`IPresenceStore.findNearestAgents(region, lat, lng, radiusM, limit)`, which is one
`GEOSEARCH ... BYRADIUS ... ASC COUNT k` followed by a pipelined read of the
candidates' meta keys. Candidates whose meta key has expired are dropped (stale)
and their geo entries removed; candidates already holding an order are dropped
(busy).

**If Redis is down, dispatch stops** — there is no Postgres fallback, because
there is no Postgres row to fall back to. Orders accumulate in `ready` and the
sweep assigns them when Redis returns. Nothing is lost and no status lies: the
customer and the restaurant both keep seeing `ready`, which is true.

The boundary between the modules is `IPresenceStore` (`pkg/presence/`). The
delivery module never touches a Redis key directly.

---

## 6. Invariants

1. A live meta key ⟹ the agent is in `presence:geo:<region>`. The reverse does
   not hold: a geo entry whose meta key expired is a tombstone, invisible to
   dispatch until the sweep collects it.
2. Offline ⟹ absent from both keys.
3. Presence never decides exclusivity. The conditional UPDATE on `orders` does,
   and it is the only check that survives a Redis flush.
4. Going offline while holding a `picked` order is forbidden.
5. A ping never reads or writes `orders`.
6. Nothing in this module compares a timestamp to decide staleness — the TTL does.

---

## 7. RBAC

Agent-self only; no permission catalog entries. The service asserts
`req.user.role === 'delivery_agent'` and derives the agent id from the JWT, so
there is no resource id to compare against.

---

## 8. WebSocket events

| Event               | Channel         | Payload                                      |
| ------------------- | --------------- | -------------------------------------------- |
| `task.offered`      | `agent:<id>`    | `DeliveryTaskResponseDTO` + `expiresAt`      |
| `task.assigned`     | `agent:<id>`    | `DeliveryTaskResponseDTO`                    |
| `task.taken`        | `agent:<id>`    | `{ orderPublicId }`                          |
| `task.cancelled`    | `agent:<id>`    | `{ orderPublicId, reason }`                  |
| `delivery.position` | `customer:<id>` | `{ orderPublicId, lat, lng, ts }` (from ping)|

`ws-auth.ts` already authorizes `agent:<userId>` for the `delivery_agent` role
(Phase 0) — this module adds no channel, only publishers.

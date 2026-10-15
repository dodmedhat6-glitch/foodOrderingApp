# Agents

Code: `app/agent/`, Redis store in `pkg/presence/`.

## Presence (Redis only)

| Endpoint | Does |
| --- | --- |
| `POST /agents/presence/online` | Registers the agent at `{lat, lng}` |
| `POST /agents/presence/ping` | Updates the position (~every 30s). 409 `NotOnline` if the agent's presence has expired; they must go online again. |
| `POST /agents/presence/offline` | Leaves; hands back an `assigned` order, refused while `picked` |

Two keys per region:
- `presence:geo:<region>`: a GEO index of agent positions, used for the
  nearest-agents search.
- `presence:meta:<region>:<agentId>`: the agent's details and active order. It
  **expires after `PRESENCE_STALE_SEC` (default 5 minutes)**. That expiry is the
  "agent is offline" rule; nothing compares timestamps.

A sweep every 60s removes geo entries whose details key has expired.

While an agent carries an order, each ping also sends `delivery.position` to
that customer. The active order is read from Redis, not Postgres, so the ping
stays cheap.

There is no presence table. If Redis is wiped, agents reappear on their next
ping, and orders they already hold are safe in Postgres.

## Task list (`GET /agents/tasks?status=`)

The agent's own orders (`assigned`, `picked`, `delivered`), newest first, with
pickup and drop-off locations and the earning estimate. Not cached, so a
just-claimed order shows up immediately.

## Earnings

Stamped once, at delivery:

```
earning = AGENT_EARNING_BASE_MINOR (15.00 EGP) + AGENT_EARNING_PER_KM_MINOR (3.00 EGP) × km
```

`km` is the straight-line distance from the branch to the drop-off point. The
amount doesn't depend on what the customer paid, and a later rate change
doesn't alter past earnings.

`GET /agents/earnings?from=&to=` (default: this month) returns the list plus
totals for the whole range.

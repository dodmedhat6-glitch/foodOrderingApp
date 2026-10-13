# Delivery & dispatch

Code: `app/delivery/`.

There is no deliveries table. A delivery is the last part of an order's life
(`ready → assigned → picked → delivered`) plus `orders.delivery_agent_id`.

## Dispatch: offer to several agents, first claim wins

1. An order becomes available as soon as the kitchen starts (`preparing`), so
   the agent can be driving to the branch while the food cooks. It is offered
   right away, and the **assignment sweep** (every 15s) catches anything missed.
2. The sweep finds up to 5 online, free agents within 5 km of the branch
   (Redis `GEOSEARCH`) and sends each one `task.offered`.
3. An agent claims with `POST /orders/:id/claim`. The claim is a single
   conditional update in Postgres, so exactly one agent wins; the others get 409
   `OrderAlreadyAssigned`. The winner gets `task.assigned`, the rest get `task.taken`.
4. Claimed while `preparing`: the agent is attached, and the order becomes
   `assigned` when the kitchen marks it `ready`.
5. Nobody claims within 45s: the order is offered again with double the radius
   (up to 20 km). After 3 rounds the admins get `assignment.stalled`. The order
   is never cancelled for this.

All of these numbers are env settings (`ASSIGNMENT_*`, `MAX_ASSIGNMENT_ATTEMPTS`).

Rules:
- One active order per agent.
- An agent must be online to claim. An admin can assign anyone with
  `POST /orders/:id/assign`, even an offline agent.
- If Redis is down, dispatch simply pauses: orders wait in `ready` and nothing
  is assigned wrongly.

## Carrying the order

Through the normal `PATCH /orders/:id/status`:

| Step | Rule |
| --- | --- |
| `assigned → picked` | Only the assigned agent |
| `picked → delivered` | Only the assigned agent; settles the money (below) |
| Unclaim (`POST /orders/:id/unclaim`) | Only before pickup; the order goes back to `ready` and is offered again |
| Going offline | Hands back an `assigned` order; refused while `picked` |

## Settlement on `delivered`

Everything happens in one transaction, and replaying it changes nothing:

1. Lock the restaurant's balance row.
2. `commission = floor(subtotal × branch commission)`. The branch value is a
   percent if it's above 1 (`10` = 10%), otherwise a fraction.
3. COD: write a `cod_collection` row for the order total.
4. Write a `commission` row.
5. Credit the restaurant's balance with `subtotal − commission`.
6. Record the agent's earning (see [agents.md](agents.md)).
7. Mark the order `delivered`, stamping the commission on it.

After the commit, the agent is marked free and the status change is broadcast.

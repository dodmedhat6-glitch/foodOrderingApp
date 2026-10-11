# Business Logic — RBAC for `order-service`

This service does **not** maintain its own permission catalog. The catalog (roles, permissions, role_permissions) lives in `core-service`. We extend it with new permissions namespaced under this service and consume permission checks via cached projection.

---

## 1. New permissions to seed in `core-service`

Seeded in core-service migration `20260418000001_seed_order_service_permissions.ts`:

```sql
INSERT INTO permissions (resource, action, created_at) VALUES
  -- Orders
  ('orders',     'read',          NOW()),
  ('orders',     'accept',        NOW()),
  ('orders',     'update',        NOW()),
  ('orders',     'cancel',        NOW()),
  -- Payments
  ('payments',   'read',          NOW()),
  ('payments',   'refund',        NOW()),
  -- Deliveries (admin only today)
  ('deliveries', 'assign',        NOW()),
  -- Finance
  ('finance',    'read',          NOW()),
  ('finance',    'payout_create', NOW())
ON CONFLICT (resource, action) DO NOTHING;
```

Mapping to roles (also seeded in the same migration):

```sql
-- owner:          all of the above
-- branch_manager: orders:read, orders:accept, orders:update, orders:cancel, finance:read
-- staff:          orders:read, orders:update, orders:accept   (no cancel, no finance, no payments)
```

`system_admin` bypasses RBAC checks entirely. `payments:refund` and `finance:payout_create` are admin-bypassed today (see §3); seeded so non-admin roles can be granted them later without a code change.

---

## 2. Resolution at request time

The `rbac()` middleware (copied from core-service shape) calls a `PermissionService` that resolves the role's permissions from a Redis-backed projection:

- Cache key: `core:rbac:perms:<roleName>`.
- Source: `core-client.getPermissionsByRole(roleName)`.
- TTL: 5 minutes.
- Invalidation: a `rbac.permissions_changed` message from core arrives over RabbitMQ (see `docs/system-design.md` §5), and the handler deletes the cache key.

If the cache lookup fails AND core-client is down → serve **stale** cache for up to 1 hour. Beyond that, deny.

---

## 3. Per-endpoint permissions table

`R/B` below abbreviates the tenant prefix
`/restaurants/{restaurantId}/branches/{branchId}`. Every endpoint whose
authorization is a **permission** rather than a role sits under it, because
`requireRestaurantMember` and `requireBranchAccess` are middleware and
middleware can only read what the path carries — the same arrangement as
`core-service`. Role-gated endpoints (customer, agent, admin) stay flat: their
subject is the JWT, so there is no tenancy to name.

| Endpoint                                             | Required permission           | Notes                                  |
| ---------------------------------------------------- | ----------------------------- | -------------------------------------- |
| `POST /orders`                                       | (customer role)               | Not RBAC — role gate                   |
| `GET /orders/{id}`                                   | (customer / agent / admin)    | Ownership in service                   |
| `GET /customer/orders`                               | (customer role)               |                                        |
| `PATCH /orders/{id}/status`                          | (customer / agent / admin)    | Cancel-in-window, picked, delivered. Rejects `restaurant_user` |
| `GET R/B/orders`                                     | `orders:read`                 | + member + `requireBranchAccess`; query filters on both ids |
| `GET R/B/orders/{id}`                                | `orders:read`                 | Same; out-of-branch id is a 404        |
| `PATCH R/B/orders/{id}/status` accept/reject         | `orders:accept`               | Action derived from `body.status`      |
| `PATCH R/B/orders/{id}/status` preparing/ready       | `orders:update`               |                                        |
| `PATCH R/B/orders/{id}/status` cancelled             | `orders:cancel`               | Customer (window) and admin use the flat route |
| `POST /payments/init`                                | (customer + own order)        |                                        |
| `POST /payments/webhook/{provider}`                  | none (HMAC)                   |                                        |
| `GET /payments/{id}`                                 | system_admin only             | Admin has no branch to name            |
| `GET R/B/payments/{id}`                              | `payments:read`               | Scope reaches the order behind it      |
| `POST /payments/{id}/refund`                         | system_admin only             |                                        |
| `POST /deliveries/assign/{orderId}`          | `deliveries:assign` or admin  |                                        |
| `POST /deliveries/reassign/{orderId}`        | `deliveries:assign` or admin  |                                        |
| `PATCH /deliveries/{id}/status`              | (delivery_agent + ownership)  | Service checks `delivery.agent_id`     |
| `POST /agents/presence/*`                    | (delivery_agent role)         |                                        |
| `GET /agents/tasks`                          | (delivery_agent role + own)   |                                        |
| `GET /agents/earnings`                       | (delivery_agent role + own)   |                                        |
| `GET /restaurant/balance`                    | `finance:read`                |                                        |
| `GET /restaurant/payouts`                    | `finance:read`                |                                        |
| `POST /restaurant/payouts`                   | system_admin only             |                                        |

---

## 4. Cross-region authorization

In addition to role/permission checks:

- A **customer** may only read an order whose `customer_id == req.user.userId`.
- A **restaurant_user** may only read orders whose `restaurant_id == req.user.restaurantId` AND (if non-owner) `branch_id ∈ req.user.branchIds`.
- A **delivery_agent** may only act on a delivery whose `agent_id == req.user.userId`.
- A **system_admin** always bypasses ownership checks but the `region` constraint still applies (if the request resolved to a concrete region via `?region=` / `X-Region` / cookie, the resource must be in that region; `region=all` is allowed only for fan-out reads).

These checks live in the **service**, not middleware, because they require a DB lookup of the resource.

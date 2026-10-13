# Permissions

This service keeps no permission tables. It uses the same JWT as core-service
and asks core which permissions a restaurant role has
(`GET /api/roles/:role/permissions`, cached for 5 minutes).

## Two kinds of check

| Caller | Check |
| --- | --- |
| Customer, agent | **Identity**: `requireRole(...)`, and the service checks the order is theirs. Endpoints are flat (`/orders/...`, `/agents/...`). |
| Restaurant user | **Permission** on a tenant: the path carries `/restaurants/:rid/branches/:bid`. Middleware checks restaurant membership, then branch access (owners skip this), then the permission. |
| System admin | Passes every check. Admin-only actions (refunds, payouts, manual assignment) use `requireRole(system_admin)`. |

Restaurant reads also filter the database by `(restaurant_id, branch_id)`, so
another branch's order simply isn't found (404).

## Permissions used

| Permission | Used for | owner | branch_manager | staff |
| --- | --- | :-: | :-: | :-: |
| `orders:read` | Branch order list and detail | ✓ | ✓ | ✓ |
| `orders:accept` | Accept / reject | ✓ | ✓ | ✓ |
| `orders:update` | `preparing`, `ready` | ✓ | ✓ | ✓ |
| `orders:cancel` | Restaurant cancels | ✓ | ✓ | |
| `payments:read` | Branch payment read | ✓ | | |
| `finance:read` | Balance, payouts, summary | ✓ | ✓ | |

`payments:refund`, `finance:payout_create` and `deliveries:assign` are seeded in
core for the future; today those actions are admin-only. The seed lives in core
migration `20261002090100_seed_order_domain_permissions.ts`.

## WebSocket rooms

After connecting, a socket may subscribe only to its own rooms:
`customer:<userId>`, `agent:<userId>`, `restaurant:<restaurantId>`,
`branch:<id>` for each branch in the token, and `admin` for system admins.

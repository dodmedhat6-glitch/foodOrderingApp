import type { Knex } from "knex";

/**
 * Seeds `analytics:read` and grants it to the `owner` restaurant role.
 *
 * analytics-service keeps no permissions catalog: its guard reads this one
 * through GET /api/roles/:role/permissions (analytics-service lib/auth.py), so
 * without this row every restaurant call to
 * /api/v1/analytics/restaurants/:restaurantId/... is a 403.
 *
 * Owner only. The analytics endpoints are restaurant-wide - one row per day
 * summed across every branch - while `branch_manager` and `staff` are scoped
 * to their own branches. Granting it to them would show a branch manager the
 * other branches' revenue. A branch-scoped endpoint (homework) can be opened
 * to them later with a role mapping, not a new permission.
 *
 * Unprefixed (`analytics`, not `core:analytics`) like order-service's
 * `orders:*`: it names another service's resource.
 */
const RESOURCE = "analytics";
const ACTION = "read";
const ROLE_NAME = "owner";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(
        `
        INSERT INTO permissions (resource, action, created_at)
        VALUES (?, ?, NOW())
        ON CONFLICT (resource, action) DO NOTHING;
    `,
        [RESOURCE, ACTION]
    );

    await knex.raw(
        `
        INSERT INTO role_permissions (role_id, permission_id, created_at)
        SELECT r.id, p.id, NOW() FROM roles r, permissions p
        WHERE r.name = ? AND p.resource = ? AND p.action = ?
        ON CONFLICT DO NOTHING;
    `,
        [ROLE_NAME, RESOURCE, ACTION]
    );
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(
        `
        DELETE FROM role_permissions
        WHERE permission_id = (SELECT id FROM permissions WHERE resource = ? AND action = ?);
    `,
        [RESOURCE, ACTION]
    );
    await knex.raw(`DELETE FROM permissions WHERE resource = ? AND action = ?;`, [RESOURCE, ACTION]);
}

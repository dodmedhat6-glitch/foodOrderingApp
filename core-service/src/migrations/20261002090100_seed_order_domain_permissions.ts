import type { Knex } from "knex";

/**
 * Seeds the permission catalog for order-service's domain and maps it onto the
 * existing restaurant roles.
 *
 * order-service keeps no permissions table of its own: its `rbac()` middleware
 * reads this catalog through GET /api/roles/:role/permissions and caches the
 * result (see order-service's lib/core-client/rbac.client.ts). So these rows
 * are what actually gates its endpoints - without them every restaurant call
 * to /api/restaurant/orders is a 403.
 *
 * Unprefixed resources (`orders`, not `core:orders`) because they name
 * another service's resources, not core's own - the `core:` prefix exists to
 * mark what lives in this database.
 *
 * `payments:refund` and `finance:payout_create` are seeded but granted to no
 * role: they are admin-bypassed today, and seeding them now means turning
 * them on later is a role mapping rather than a migration.
 * See docs/implementation-plan.md Phase 0 s0.5 on the order-service side.
 */
const PERMISSIONS: Array<[resource: string, action: string]> = [
    ["orders", "read"],
    ["orders", "accept"],
    ["orders", "update"],
    ["orders", "cancel"],
    ["payments", "read"],
    ["payments", "refund"],
    ["deliveries", "assign"],
    ["finance", "read"],
    ["finance", "payout_create"],
];

const ROLE_GRANTS: Record<string, string[]> = {
    owner: PERMISSIONS.map(([resource, action]) => `${resource}:${action}`),
    branch_manager: [
        "orders:read",
        "orders:accept",
        "orders:update",
        "orders:cancel",
        "finance:read",
    ],
    staff: ["orders:read", "orders:accept", "orders:update"],
};

export async function up(knex: Knex): Promise<void> {
    for (const [resource, action] of PERMISSIONS) {
        await knex.raw(
            `
            INSERT INTO permissions (resource, action, created_at)
            VALUES (?, ?, NOW())
            ON CONFLICT (resource, action) DO NOTHING;
        `,
            [resource, action]
        );
    }

    for (const [roleName, granted] of Object.entries(ROLE_GRANTS)) {
        await knex.raw(
            `
            INSERT INTO role_permissions (role_id, permission_id, created_at)
            SELECT r.id, p.id, NOW() FROM roles r, permissions p
            WHERE r.name = ?
              AND p.resource || ':' || p.action = ANY(?)
            ON CONFLICT DO NOTHING;
        `,
            [roleName, granted]
        );
    }
}

export async function down(knex: Knex): Promise<void> {
    const all = PERMISSIONS.map(([resource, action]) => `${resource}:${action}`);
    await knex.raw(
        `
        DELETE FROM role_permissions
        WHERE permission_id IN (
            SELECT id FROM permissions WHERE resource || ':' || action = ANY(?)
        );
    `,
        [all]
    );
    await knex.raw(
        `DELETE FROM permissions WHERE resource || ':' || action = ANY(?);`,
        [all]
    );
}

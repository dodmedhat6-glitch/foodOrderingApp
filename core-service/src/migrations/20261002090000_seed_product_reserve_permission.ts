import type { Knex } from "knex";

/**
 * Grants the `order_service` role `core:product:reserve`, which guards
 * POST /api/internal/branches/:branchId/reserve-stock (app/internal/routes.ts).
 *
 * Deliberately a distinct action from `update`: order-service must be able to
 * decrement stock for an order it has committed, and nothing more. Granting it
 * `core:product:update` would also hand it product names, prices and
 * availability.
 */
const ROLE_NAME = "order_service";
const RESOURCE = "core:product";
const ACTION = "reserve";

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
        WHERE role_id = (SELECT id FROM roles WHERE name = ?)
          AND permission_id = (SELECT id FROM permissions WHERE resource = ? AND action = ?);
    `,
        [ROLE_NAME, RESOURCE, ACTION]
    );
}

import type { Knex } from "knex";

/**
 * Seeds `core:media` create/read/delete and grants them to the restaurant
 * roles. Without these rows every media call from a restaurant user is a 403
 * (lib/auth/rbac.ts) - system_admin bypasses the lookup entirely.
 *
 * owner and branch_manager can upload and remove; staff can only read. Deleting
 * a logo or product image is not a day-to-day staff action.
 */
const RESOURCE = "core:media";
const ACTIONS = ["create", "read", "delete"];
const GRANTS: Record<string, string[]> = {
    owner: ["create", "read", "delete"],
    branch_manager: ["create", "read", "delete"],
    staff: ["read"],
};

export async function up(knex: Knex): Promise<void> {
    for (const action of ACTIONS) {
        await knex.raw(
            `
            INSERT INTO permissions (resource, action, created_at)
            VALUES (?, ?, NOW())
            ON CONFLICT (resource, action) DO NOTHING;
        `,
            [RESOURCE, action]
        );
    }

    for (const [roleName, actions] of Object.entries(GRANTS)) {
        for (const action of actions) {
            await knex.raw(
                `
                INSERT INTO role_permissions (role_id, permission_id, created_at)
                SELECT r.id, p.id, NOW() FROM roles r, permissions p
                WHERE r.name = ? AND p.resource = ? AND p.action = ?
                ON CONFLICT DO NOTHING;
            `,
                [roleName, RESOURCE, action]
            );
        }
    }
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(
        `
        DELETE FROM role_permissions
        WHERE permission_id IN (SELECT id FROM permissions WHERE resource = ?);
    `,
        [RESOURCE]
    );
    await knex.raw(`DELETE FROM permissions WHERE resource = ?;`, [RESOURCE]);
}

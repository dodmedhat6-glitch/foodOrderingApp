import type { Knex } from "knex";
import { env } from "../lib/config/env";
import { hashApiKey } from "../pkg/api-key/hash";

const ROLE_NAME = "order_service";
const PERMISSIONS: Array<[resource: string, action: string]> = [
    ["core:branch", "read"],
    ["core:restaurant", "read"],
    ["core:address", "read"],
    ["core:user", "read"],
    ["core:product", "read"],
];

export async function up(knex: Knex): Promise<void> {
    await knex.raw(
        `
        INSERT INTO roles (name, display_name, description, created_at, updated_at)
        VALUES (?, 'Order Service', 'Service account for order-service cross-service reads (branch/address/user/product lookups)', NOW(), NOW())
        ON CONFLICT (name) DO NOTHING;
    `,
        [ROLE_NAME]
    );

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

    await knex.raw(
        `
        INSERT INTO role_permissions (role_id, permission_id, created_at)
        SELECT r.id, p.id, NOW() FROM roles r, permissions p
        WHERE r.name = ?
        AND p.resource || ':' || p.action IN (?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING;
    `,
        [ROLE_NAME, ...PERMISSIONS.map(([resource, action]) => `${resource}:${action}`)]
    );

    const keyHash = hashApiKey(env.serviceApiKeys.orderService);
    await knex.raw(
        `
        INSERT INTO api_keys (name, key_hash, role_id, status, created_at, updated_at)
        SELECT 'order-service', ?, r.id, 'active', NOW(), NOW()
        FROM roles r WHERE r.name = ?
        ON CONFLICT (name) DO UPDATE SET key_hash = EXCLUDED.key_hash, updated_at = NOW();
    `,
        [keyHash, ROLE_NAME]
    );
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DELETE FROM api_keys WHERE name = 'order-service';`);
    await knex.raw(`DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE name = ?);`, [ROLE_NAME]);
    await knex.raw(`DELETE FROM roles WHERE name = ?;`, [ROLE_NAME]);
}

import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        INSERT INTO restaurants (
            owner_id,
            name,
            logo_url,
            status,
            primary_country,
            create_at,
            updated_at,
            status_updated_at
        )
        SELECT
            users.id,
            seed.name,
            seed.logo_url,
            seed.status,
            seed.primary_country,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        FROM (
            VALUES
                ('Cairo Kitchen', 'https://example.com/logos/cairo-kitchen.png', 'active', 'EG'),
                ('Nile Bites', 'https://example.com/logos/nile-bites.png', 'active', 'EG'),
                ('Alexandria Grill', 'https://example.com/logos/alexandria-grill.png', 'pending', 'EG'),
                ('Levant Table', 'https://example.com/logos/levant-table.png', 'suspended', 'JO'),
                ('Mediterranean Bowl', 'https://example.com/logos/mediterranean-bowl.png', 'active', 'LB')
        ) AS seed(name, logo_url, status, primary_country)
        CROSS JOIN (
            SELECT id
            FROM users
            WHERE system_role = 'restaurant_user'
            ORDER BY id
            LIMIT 1
        ) AS users
        WHERE NOT EXISTS (
            SELECT 1
            FROM restaurants existing
            WHERE existing.name = seed.name
        );
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex("restaurants")
        .whereIn("name", [
            "Cairo Kitchen",
            "Nile Bites",
            "Alexandria Grill",
            "Levant Table",
            "Mediterranean Bowl"
        ])
        .del();
}

import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE restaurant_branches (
            id BIGSERIAL PRIMARY KEY,
            restaurant_id BIGINT NOT NULL REFERENCES restaurants(id),
            country_code TEXT NOT NULL,
            address_text TEXT NOT NULL,
            label TEXT NOT NULL,
            lat DOUBLE PRECISION NOT NULL,
            lng DOUBLE PRECISION NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT false,
            opens_at TIME NOT NULL,
            closes_at TIME NOT NULL,
            accept_orders BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            delivery_radius INTEGER NOT NULL,
            currency VARCHAR(255),
            commission INTEGER NOT NULL DEFAULT 0
        );
    `);

    await knex.raw(`
        CREATE INDEX idx_restaurant_branches_restaurant_id ON restaurant_branches(restaurant_id);
        CREATE INDEX idx_restaurant_branches_is_active ON restaurant_branches(is_active);
        CREATE INDEX idx_restaurant_branches_lat_lng ON restaurant_branches(lat, lng);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS restaurant_branches;`);
}


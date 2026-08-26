import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE IF NOT EXISTS customer_addresses (
            id SERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            label VARCHAR(50) NOT NULL,
            text VARCHAR(255) NOT NULL,
            lat DECIMAL(9,6) NOT NULL,
            lng DECIMAL(9,6) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_default BOOLEAN DEFAULT FALSE,
            country VARCHAR(100) NOT NULL,
            city VARCHAR(100) NOT NULL,
            street VARCHAR(100) NOT NULL,
            building VARCHAR(100) NOT NULL,
            apartment_number VARCHAR(100) NOT NULL,
            type VARCHAR(50) NOT NULL CHECK (type IN ('home', 'work', 'other'))
        );
        CREATE INDEX IF NOT EXISTS idx_customer_addresses_user_id ON customer_addresses(user_id);
    `);
}


export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS customer_addresses;`);
}


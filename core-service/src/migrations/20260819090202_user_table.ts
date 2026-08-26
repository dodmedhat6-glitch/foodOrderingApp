import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL  PRIMARY KEY,
            username VARCHAR(255) NOT NULL UNIQUE,
            email VARCHAR(255) NOT NULL UNIQUE,
            phone VARCHAR(20) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            system_role VARCHAR(50) NOT NULL CHECK (system_role IN ('system_admin', 'restaurant_user', 'customer', 'delivery_agent')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_user_system_role ON users(system_role);

    `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS users;`);
}

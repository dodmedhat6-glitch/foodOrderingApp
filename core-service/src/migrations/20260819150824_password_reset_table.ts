import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE IF NOT EXISTS password_reset (
            id SERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            otp_code VARCHAR(6) NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            consumed_at TIMESTAMP NULL
        );
        CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON password_reset(user_id);
    `);
}


export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS password_reset;`);
}


import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE api_keys (
            id BIGSERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            key_hash TEXT UNIQUE NOT NULL,
            role_id SMALLINT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
            last_used_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL,

            CONSTRAINT fk_api_keys_role_id FOREIGN KEY (role_id) REFERENCES roles(id)
        );

        CREATE INDEX idx_api_keys_role_id ON api_keys(role_id);
        CREATE INDEX idx_api_keys_status ON api_keys(status);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DROP TABLE IF EXISTS api_keys;
    `);
}

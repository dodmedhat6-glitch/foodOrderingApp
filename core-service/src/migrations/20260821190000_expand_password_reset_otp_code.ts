import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable("password_reset", (table) => {
        // SHA-256 hashes are 64 hexadecimal characters.
        table.string("otp_code", 64).notNullable().alter();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable("password_reset", (table) => {
        table.string("otp_code", 6).notNullable().alter();
    });
}

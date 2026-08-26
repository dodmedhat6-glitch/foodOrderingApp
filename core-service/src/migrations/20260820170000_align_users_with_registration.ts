import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS name VARCHAR(255);

    UPDATE users
      SET name = username
      WHERE name IS NULL;

    ALTER TABLE users
      ALTER COLUMN name SET NOT NULL;

    ALTER TABLE users
      DROP COLUMN IF EXISTS username;
  `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS username VARCHAR(255);

    UPDATE users
      SET username = name
      WHERE username IS NULL;

    ALTER TABLE users
      ALTER COLUMN username SET NOT NULL;

    ALTER TABLE users
      DROP COLUMN IF EXISTS name;
  `);
}

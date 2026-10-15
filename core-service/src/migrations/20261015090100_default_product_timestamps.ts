import type { Knex } from "knex";

// product_categories / products declare created_at and updated_at NOT NULL with no default,
// and the repositories never write them on insert - POST /restaurants/:id/products failed with a 500.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE product_categories
            ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
            ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE products
            ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
            ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE products
            ALTER COLUMN created_at DROP DEFAULT,
            ALTER COLUMN updated_at DROP DEFAULT;
        ALTER TABLE product_categories
            ALTER COLUMN created_at DROP DEFAULT,
            ALTER COLUMN updated_at DROP DEFAULT;
    `);
}

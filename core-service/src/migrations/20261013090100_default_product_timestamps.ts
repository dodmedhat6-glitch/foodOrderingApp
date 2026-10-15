import type { Knex } from "knex";

/**
 * `product_categories` and `products` declared `created_at` / `updated_at` as
 * NOT NULL with no default, and neither repository's insert supplies them, so
 * creating a category or a product always failed with a not-null violation.
 * A default fixes every insert path at once and leaves existing rows as they are.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE product_categories
            ALTER COLUMN created_at SET DEFAULT NOW(),
            ALTER COLUMN updated_at SET DEFAULT NOW();
        ALTER TABLE products
            ALTER COLUMN created_at SET DEFAULT NOW(),
            ALTER COLUMN updated_at SET DEFAULT NOW();
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE product_categories
            ALTER COLUMN created_at DROP DEFAULT,
            ALTER COLUMN updated_at DROP DEFAULT;
        ALTER TABLE products
            ALTER COLUMN created_at DROP DEFAULT,
            ALTER COLUMN updated_at DROP DEFAULT;
    `);
}

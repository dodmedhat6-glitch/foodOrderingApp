import type { Knex } from "knex";

// customer_addresses: the type CHECK did not match AddressType (office/home/public_place).
// restaurants: the status CHECK allowed 'disable' while RestaurantStatus.DISABLED is 'disabled'.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_type_check;
        UPDATE customer_addresses SET type = 'office' WHERE type = 'work';
        UPDATE customer_addresses SET type = 'public_place' WHERE type = 'other';
        ALTER TABLE customer_addresses
            ADD CONSTRAINT customer_addresses_type_check CHECK (type IN ('office', 'home', 'public_place'));

        ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_status_check;
        UPDATE restaurants SET status = 'disabled' WHERE status = 'disable';
        ALTER TABLE restaurants
            ADD CONSTRAINT restaurants_status_check CHECK (status IN ('active', 'suspended', 'disabled', 'pending'));
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_status_check;
        UPDATE restaurants SET status = 'disable' WHERE status = 'disabled';
        ALTER TABLE restaurants
            ADD CONSTRAINT restaurants_status_check CHECK (status IN ('active', 'suspended', 'disable', 'pending'));

        ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_type_check;
        UPDATE customer_addresses SET type = 'work' WHERE type = 'office';
        UPDATE customer_addresses SET type = 'other' WHERE type = 'public_place';
        ALTER TABLE customer_addresses
            ADD CONSTRAINT customer_addresses_type_check CHECK (type IN ('home', 'work', 'other'));
    `);
}

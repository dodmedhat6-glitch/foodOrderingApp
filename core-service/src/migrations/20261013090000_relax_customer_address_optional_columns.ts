import type { Knex } from "knex";

/**
 * Aligns `customer_addresses` with the address module.
 *
 * The table made `text`, `building` and `apartment_number` NOT NULL, but the
 * module never writes `text` (the display string is composed from the parts
 * on read - InternalService.getAddress) and treats building / apartment as
 * optional (CreateAddressDTO, CustomerAddress entity). Every insert therefore
 * failed on the NOT NULL `text` column.
 *
 * Dropping NOT NULL is idempotent and keeps existing rows as they are.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE customer_addresses
            ALTER COLUMN text DROP NOT NULL,
            ALTER COLUMN building DROP NOT NULL,
            ALTER COLUMN apartment_number DROP NOT NULL;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        UPDATE customer_addresses SET text = '' WHERE text IS NULL;
        UPDATE customer_addresses SET building = '' WHERE building IS NULL;
        UPDATE customer_addresses SET apartment_number = '' WHERE apartment_number IS NULL;
        ALTER TABLE customer_addresses
            ALTER COLUMN text SET NOT NULL,
            ALTER COLUMN building SET NOT NULL,
            ALTER COLUMN apartment_number SET NOT NULL;
    `);
}

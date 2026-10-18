import type {Knex} from "knex";

/**
 * `order_items` — the order's line items, with price/name/image snapshotted at
 * order time so a historical order stays readable after the product changes.
 *
 * Deliberately NOT partitioned (unlike `orders`): keeping it a plain table
 * preserves a real btree on order_id with no partition fan-out on the
 * single-order read, which is the only way this table is ever queried.
 *
 * There is no FK to orders(id): the parent is partitioned, and Postgres only
 * allows a FK into a partitioned table through a unique index that contains
 * the partition key — which would mean carrying a denormalized created_at
 * here. The reference is enforced in the application instead: order header and
 * items are inserted in the same transaction in order.service.placeOrder, and
 * archival deletes items by order_id alongside the parent.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE order_items (
            id                  BIGSERIAL PRIMARY KEY,
            region              TEXT NOT NULL,
            order_id            BIGINT NOT NULL,          -- logical FK -> orders.id (partitioned parent, see above)
            product_id          BIGINT NOT NULL,          -- logical FK -> core.products.id
            quantity            INT NOT NULL CHECK (quantity > 0),
            unit_price_snapshot INT NOT NULL CHECK (unit_price_snapshot >= 0),
            name_snapshot       TEXT NOT NULL,
            image_url_snapshot  TEXT NULL,
            line_total          INT NOT NULL,
            created_at          TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT ck_order_items_line_total CHECK (line_total = quantity * unit_price_snapshot)
        );

        -- supports GET /api/orders/{publicId} expansion, and the batched
        -- whereIn('order_id', ids) used by every list endpoint (no N+1)
        CREATE INDEX idx_order_items_order_id ON order_items (order_id);
        -- (no product_id index: this service never queries items by product)
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS order_items;`);
}

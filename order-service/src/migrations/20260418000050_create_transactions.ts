import type {Knex} from "knex";

/**
 * `transactions` — the money ledger. Every movement is one row: charges,
 * refunds, COD collections, commissions, payouts and adjustments
 * (docs/database-design.md s3.5). There is deliberately no `payouts` table;
 * a payout is a `transaction_type`.
 *
 * `amount` is always **positive** and always minor units. Direction is
 * carried by `(transaction_type, src_acc_id, dst_acc_id)`, where a NULL
 * account means the platform.
 *
 * Two deviations from the draft:
 *
 *  1. **No FK to `orders`.** `orders` is partitioned, so Postgres will not
 *     accept a FK that does not contain the partition key — same constraint
 *     that shaped `order_items` and `payment_sessions`. The reference is
 *     logical; every writer holds the order already.
 *  2. **`order_public_id`.** `GET /api/payments/{id}` returns the order's
 *     public id and authorises against the order's restaurant, so it has to
 *     reach the order row. With only the bigserial `order_id` that is a scan
 *     across every partition; the UUIDv7 public id carries its own timestamp
 *     and prunes to one. NULL for the payouts that belong to no order.
 *
 * The self-referencing `refunded_payment_id` FK *is* created — this table is
 * not partitioned, so nothing stands in the way.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE transactions (
            id                    BIGSERIAL PRIMARY KEY,
            region                TEXT NOT NULL,
            order_id              BIGINT NULL,          -- logical FK -> orders.id; NULL for a payout
            order_public_id       UUID NULL,
            transaction_type      TEXT NOT NULL CHECK (transaction_type IN (
                                      'charge','refund','commission','payout','cod_collection','adjustment'
                                  )),
            method                TEXT NOT NULL CHECK (method IN ('online','cod','bank_transfer','system')),
            provider_id           INT NULL,             -- logical FK -> payment_providers.id; NULL for commission/adjustment
            provider_reference_id TEXT NULL,            -- Kashier transactionId / bank ref
            status                TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','reversed')),
            amount                INT NOT NULL CHECK (amount > 0),   -- minor units, always positive
            currency              TEXT NOT NULL,

            -- accounting: logical user ids in core. NULL => the platform.
            src_acc_id            BIGINT NULL,
            dst_acc_id            BIGINT NULL,

            -- refund linkage
            is_refunded           BOOLEAN NOT NULL DEFAULT FALSE,
            refunded_payment_id   BIGINT NULL,

            -- upstream idempotency (a webhook event id, an admin retry key)
            idempotency_key       TEXT NULL,
            created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT fk_transactions_refunded_payment_id
                FOREIGN KEY (refunded_payment_id) REFERENCES transactions(id),
            -- invariant 5 (docs/business-logic/payments.md s8): the one thing
            -- that makes a replayed webhook incapable of double-crediting,
            -- whatever happens above it. NULLs are not compared in Postgres,
            -- so rows without an upstream key are unaffected.
            CONSTRAINT uq_transactions_idempotency_key UNIQUE (idempotency_key)
        );

        -- supports the order detail's ledger expansion, and the refund path
        -- finding a charge's prior refunds in one query
        CREATE INDEX idx_transactions_order_id ON transactions (order_id);
        -- supports matching a refund webhook back to the pending refund row
        CREATE INDEX idx_transactions_provider_reference_id ON transactions (provider_reference_id)
            WHERE provider_reference_id IS NOT NULL;
        -- supports GET /api/restaurant/payouts?from=&to= (Phase 5)
        CREATE INDEX idx_transactions_dst_acc_type_created_at
            ON transactions (dst_acc_id, transaction_type, created_at DESC)
            WHERE transaction_type = 'payout';
        -- supports admin reconciliation by type + status
        CREATE INDEX idx_transactions_type_status_created_at
            ON transactions (transaction_type, status, created_at DESC);
        -- supports the FK above (Postgres does not auto-index a FK column)
        CREATE INDEX idx_transactions_refunded_payment_id ON transactions (refunded_payment_id)
            WHERE refunded_payment_id IS NOT NULL;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS transactions;`);
}

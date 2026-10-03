import type {Knex} from "knex";

/**
 * `orders` — the order header, and the primary write target of this service.
 *
 * Partitioned by RANGE (created_at), one partition per month. Three
 * consequences of partitioning that shape the DDL below:
 *
 *  1. Every unique constraint must contain the partition key, so the PK is
 *     (id, created_at) and public_id is unique per (public_id, created_at)
 *     rather than globally. Global uniqueness of public_id is therefore an
 *     application guarantee, not a DB one — we mint it as a UUIDv7, so a
 *     collision needs both a 74-bit random collision and the same millisecond.
 *  2. public_id is a UUIDv7, which embeds its creation timestamp. That lets
 *     `findOrderByPublicId` derive a created_at window and prune to a single
 *     partition instead of probing every month's index.
 *  3. Child tables cannot FK to a partitioned parent unless they carry the
 *     partition key, so `order_items.order_id` is a logical reference only
 *     (both rows are written in the same service transaction).
 *
 * Partition maintenance is native — no pg_partman (no Windows/PG18 build).
 * `lib/jobs/partition-maintenance.ts` pre-creates future months; this
 * migration seeds the window around the deploy date plus a DEFAULT partition
 * so a write can never fail for want of a partition.
 */

// Seeded window: last month (late-arriving backfills) through +3 months.
const SEED_MONTHS_BACK = 1;
const SEED_MONTHS_AHEAD = 3;

function monthStart(year: number, monthIndex0: number): Date {
    return new Date(Date.UTC(year, monthIndex0, 1, 0, 0, 0, 0));
}

function partitionName(from: Date): string {
    const yyyy = from.getUTCFullYear();
    const mm = String(from.getUTCMonth() + 1).padStart(2, "0");
    return `orders_${yyyy}${mm}`;
}

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE orders (
            id                              BIGSERIAL,
            region                          TEXT NOT NULL,
            public_id                       UUID NOT NULL,
            country_code                    TEXT NOT NULL,
            restaurant_id                   BIGINT NOT NULL,          -- logical FK -> core.restaurants.id
            branch_id                       BIGINT NOT NULL,          -- logical FK -> core.restaurant_branches.id
            customer_id                     BIGINT NOT NULL,          -- logical FK -> core.users.id
            customer_address_id             BIGINT NOT NULL,          -- logical FK -> core.customer_addresses.id

            -- delivery snapshot: the order stays coherent after the customer edits or deletes the address
            delivery_lat                    DECIMAL(10,7) NOT NULL,
            delivery_lng                    DECIMAL(10,7) NOT NULL,
            delivery_address_text_snapshot  TEXT NOT NULL,

            -- names snapshotted from core at order time. Every order response
            -- carries branch.name and restaurant.name (docs/api-contracts.md
            -- s1.1); holding them here keeps a list read one SQL query with no
            -- per-row call into core, and keeps a delivered order readable
            -- after a rename.
            branch_name_snapshot            TEXT NOT NULL,
            restaurant_name_snapshot        TEXT NOT NULL,

            status                          TEXT NOT NULL CHECK (status IN (
                                                'pending_payment','placed','accepted','rejected',
                                                'preparing','ready','assigned','picked','delivered','cancelled'
                                            )),
            -- reason supplied by the actor on a rejected/cancelled transition
            status_reason                   TEXT NULL,

            -- money, minor units (CLAUDE.md s7)
            subtotal                        INT NOT NULL CHECK (subtotal >= 0),
            delivery_fee                    INT NOT NULL CHECK (delivery_fee >= 0),
            service_fee                     INT NOT NULL CHECK (service_fee >= 0),
            total                           INT NOT NULL,
            commission                      INT NOT NULL DEFAULT 0 CHECK (commission >= 0),
            currency                        TEXT NOT NULL,

            payment_method                  TEXT NOT NULL CHECK (payment_method IN ('online','cod')),
            delivery_agent_id               BIGINT NULL,              -- logical FK -> core.users.id

            created_at                      TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at                      TIMESTAMP NOT NULL DEFAULT NOW(),
            placed_at                       TIMESTAMP NULL,
            accepted_at                     TIMESTAMP NULL,
            rejected_at                     TIMESTAMP NULL,
            preparing_at                    TIMESTAMP NULL,
            ready_at                        TIMESTAMP NULL,
            assigned_at                     TIMESTAMP NULL,
            picked_at                       TIMESTAMP NULL,
            delivered_at                    TIMESTAMP NULL,
            cancelled_at                    TIMESTAMP NULL,

            CONSTRAINT pk_orders PRIMARY KEY (id, created_at),
            CONSTRAINT uq_orders_public_id_created_at UNIQUE (public_id, created_at),
            -- invariant 1 in docs/business-logic/orders.md s8
            CONSTRAINT ck_orders_total CHECK (total = subtotal + delivery_fee + service_fee),
            -- invariant 2
            CONSTRAINT ck_orders_commission_le_subtotal CHECK (commission <= subtotal)
        ) PARTITION BY RANGE (created_at);

        -- supports GET /api/orders/{publicId}; pruned to one partition by the
        -- created_at window derived from the UUIDv7 timestamp
        CREATE INDEX idx_orders_public_id ON orders (public_id);
        -- supports GET /api/customer/orders?year=YYYY
        CREATE INDEX idx_orders_customer_id_created_at ON orders (customer_id, created_at DESC);
        -- supports GET /api/restaurant/orders?branchId=&status=&from=&to= (hottest read path)
        CREATE INDEX idx_orders_branch_status_created_at ON orders (branch_id, status, created_at DESC);
        -- supports the delivery-assignment sweep for unassigned orders in a region (Phase 3)
        CREATE INDEX idx_orders_status_created_at ON orders (status, created_at)
            WHERE status IN ('ready','assigned');
        -- supports GET /api/agents/tasks?status= (Phase 4)
        CREATE INDEX idx_orders_delivery_agent_id_status ON orders (delivery_agent_id, status)
            WHERE delivery_agent_id IS NOT NULL;
    `);

    // Safety net: a write whose created_at falls outside every month partition
    // lands here instead of failing. The maintenance job keeps it empty.
    await knex.raw(`CREATE TABLE orders_default PARTITION OF orders DEFAULT;`);

    const now = new Date();
    for (let offset = -SEED_MONTHS_BACK; offset <= SEED_MONTHS_AHEAD; offset++) {
        const from = monthStart(now.getUTCFullYear(), now.getUTCMonth() + offset);
        const to = monthStart(from.getUTCFullYear(), from.getUTCMonth() + 1);
        await knex.raw(
            `CREATE TABLE ${partitionName(from)} PARTITION OF orders
             FOR VALUES FROM ('${isoDate(from)}') TO ('${isoDate(to)}');`,
        );
    }
}

export async function down(knex: Knex): Promise<void> {
    // Dropping the parent drops every attached partition.
    await knex.raw(`DROP TABLE IF EXISTS orders CASCADE;`);
}

import {db} from '../../src/lib/knex/kenx';

/**
 * Tables that must survive between tests.
 *
 *  - knex_migrations*  the migration ledger; truncating it makes knex replay
 *                      every migration against an already-populated schema.
 *  - spatial_ref_sys   PostGIS's own spatial-reference registry (~8500 rows),
 *                      installed by CREATE EXTENSION postgis in
 *                      20260831130551_create_restaurant_branches_tabel.ts.
 *                      Truncating it breaks every geography(Point, 4326)
 *                      column, and `CREATE EXTENSION IF NOT EXISTS` will not
 *                      refill it.
 *  - roles / permissions / role_permissions / api_keys
 *                      RBAC reference data seeded by migrations. Tests read it
 *                      (route authorization, service-to-service API keys) and
 *                      never own it. tests/integration/setup.ts re-applies the
 *                      seeds on every run, so losing it is recoverable - but
 *                      keeping it avoids re-seeding between every test.
 *
 * Fixture data that tests do own - users, restaurants, branches, products,
 * addresses, outbox rows - is truncated, including the demo rows from
 * 20260920000000_seed_restaurants.ts. That seed CROSS JOINs a
 * system_role = 'restaurant_user' user, so it yields nothing on a fresh test
 * database anyway; tests should arrange their own restaurants.
 */
const PRESERVED_TABLES = [
    'knex_migrations',
    'knex_migrations_lock',
    'spatial_ref_sys',
    'roles',
    'permissions',
    'role_permissions',
    'api_keys',
];

/**
 * TRUNCATE ... CASCADE also empties any table holding a foreign key into one
 * of the truncated tables. A preserved table that gains such a key would be
 * wiped silently, which is exactly the failure this module exists to prevent,
 * so check for it rather than trusting the list to stay correct.
 */
async function assertPreservedTablesAreSafe(): Promise<void> {
    const result = await db.raw<{rows: {src: string; tgt: string}[]}>(
        `
        SELECT src.relname AS src, tgt.relname AS tgt
        FROM pg_constraint c
        JOIN pg_class src ON src.oid = c.conrelid
        JOIN pg_class tgt ON tgt.oid = c.confrelid
        WHERE c.contype = 'f'
          AND src.relname = ANY(?)
          AND NOT (tgt.relname = ANY(?));
    `,
        [PRESERVED_TABLES, PRESERVED_TABLES],
    );

    if (result.rows.length > 0) {
        const edges = result.rows.map(r => `${r.src} -> ${r.tgt}`).join(', ');
        throw new Error(
            `truncateAll() would empty a preserved table via CASCADE (${edges}). ` +
                `Either add the referenced table to PRESERVED_TABLES or stop preserving the referencing one.`,
        );
    }
}

async function truncatableTables(): Promise<string[]> {
    // pg returns the column as `tablename` (all lowercase), not `tableName`.
    const result = await db.raw<{rows: {tablename: string}[]}>(
        `
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
        AND NOT (tablename = ANY(?));
    `,
        [PRESERVED_TABLES],
    );
    return result.rows.map(r => r.tablename);
}

/**
 * Clears all per-test fixture data, leaving seeded reference data in place.
 */
export async function truncateAll() {
    await assertPreservedTablesAreSafe();

    const tables = await truncatableTables();
    if (tables.length === 0) {
        return;
    }
    const quoted = tables.map(t => `"${t}"`).join(', ');
    await db.raw(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`);
}

/**
 * The tables truncateAll() deliberately leaves alone. Exported so a test that
 * really needs an empty RBAC table can work around the set rather than
 * rediscovering it.
 */
export function preservedTables(): readonly string[] {
    return PRESERVED_TABLES;
}

import knex from "knex";
import config from "./knexConfig";

/**
 * Two migrations were renamed so a fresh database can be built from scratch:
 * they had timestamps earlier than the tables they reference, so
 * `migrate:latest` on an empty database stopped at
 * `relation "restaurants" does not exist`.
 *
 * A database that already ran them still has the old names in
 * `knex_migrations`, and knex refuses to run against a directory missing files
 * it has recorded. This rewrites those rows to the new names. Idempotent: on a
 * fresh database, or one already rewritten, it changes nothing.
 *
 * Runs before every `npm run migrate`.
 */
const RENAMES: ReadonlyArray<[string, string]> = [
    ["20260224200000_create_products_tables.ts", "20260831130600_create_products_tables.ts"],
    ["20260327014716_seed_rbac_data.ts", "20260901121500_seed_rbac_data.ts"],
];

async function main(): Promise<void> {
    const conn = knex(config);
    try {
        if (!(await conn.schema.hasTable("knex_migrations"))) return;
        for (const [from, to] of RENAMES) {
            const n = await conn("knex_migrations").where("name", from).update({name: to});
            if (n > 0) console.log(`knex_migrations: ${from} -> ${to}`);
        }
    } finally {
        await conn.destroy();
    }
}

main().catch((err) => {
    console.error("rename-legacy-migrations failed:", err.message);
    process.exit(1);
});

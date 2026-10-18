import fs from 'fs';
import path from 'path';
import type {Knex} from 'knex';
import {createMigrationDb, migrationsDirectory} from './db';

/**
 * Seed migrations are re-applied on every run, not just the first.
 *
 * `migrate.latest()` only runs what the knex_migrations ledger says is
 * pending, so once a seed has been recorded its data is never restored - and
 * integration tests routinely remove rows. tests/helpers/db.ts preserves the
 * seeded reference tables, but that only protects a database that still has
 * the data; a database that lost it stays broken forever.
 *
 * Every seed migration in src/migrations is idempotent (ON CONFLICT DO NOTHING
 * / WHERE NOT EXISTS / ON CONFLICT DO UPDATE), so replaying `up()` is safe and
 * makes the test database self-healing. Identified by the `seed` filename
 * convention that all of them follow.
 */
function seedMigrationFiles(): string[] {
    return fs
        .readdirSync(migrationsDirectory())
        .filter(f => f.endsWith('.ts') && f.includes('seed'))
        .sort();
}

async function applySeeds(db: Knex): Promise<void> {
    for (const file of seedMigrationFiles()) {
        const migration = require(path.join(migrationsDirectory(), file));
        if (typeof migration.up !== 'function') {
            throw new Error(`seed migration ${file} has no up() export`);
        }
        await migration.up(db);
    }
}

export default async function globalSetup() {
    const db = createMigrationDb();
    try {
        await db.migrate.latest();
        await applySeeds(db);
    } finally {
        await db.destroy();
    }
}

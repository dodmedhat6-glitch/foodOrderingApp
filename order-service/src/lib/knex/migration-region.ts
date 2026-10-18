import type {Knex} from "knex";
import {env} from "../config/env";

/**
 * Which shard is this migration running against?
 *
 * Almost every migration is region-blind — the schema is identical on every
 * shard — but a *seed* need not be: `payment_providers` carries only the
 * gateways a region can actually charge through.
 *
 * Deliberately derived from the live connection rather than `process.env.REGION`.
 * `npm run migrate` sets that var (knexfile.ts requires it), but
 * `npm run migrate:all` — the normal path — loops the shards in-process and
 * never sets it. A migration reading it directly would therefore see
 * `undefined` on the run that matters and silently seed nothing anywhere.
 *
 * The match is on database name, which is unique across the fleet: regions may
 * share a host and port (they do locally) but never a database. Hot and archive
 * clusters of the same region resolve to the same region, which is what a
 * region-conditional seed wants — the archive carries the same schema and the
 * same lookup rows as the hot shard it mirrors.
 */
export async function resolveMigrationRegion(conn: Knex): Promise<string> {
    const {rows} = await conn.raw<{rows: Array<{current_database: string}>}>(
        "SELECT current_database()",
    );
    const database = rows[0].current_database;

    for (const shards of [env.hotShards, env.archiveShards]) {
        for (const [region, shard] of Object.entries(shards)) {
            if (shard.name === database) return region;
        }
    }

    throw new Error(
        `Cannot resolve a region for database "${database}". It matches no configured hot or ` +
            `archive shard — check REGIONS and the DB_*/ARCHIVE_DB_*_NAME vars in .env.`,
    );
}

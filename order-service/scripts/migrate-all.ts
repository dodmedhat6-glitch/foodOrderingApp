/**
 * Runs knex migrations across every configured shard.
 *
 * `npm run migrate` (knexfile.ts) hits exactly one region+cluster and is the
 * right tool when you're debugging a single shard. This script is the one you
 * use normally: every region must carry the same schema, so a migration that
 * lands on `eg` but not `sa` is a bug waiting to happen.
 *
 *   npm run migrate:all                              # latest, hot cluster, all regions
 *   npm run migrate:all -- --cluster=archive         # same schema onto the archive cluster (Phase 7)
 *   npm run migrate:all -- --region=eg               # one region only
 *   npm run migrate:all -- --action=status
 *   npm run migrate:all -- --action=rollback
 *
 * Shards are processed sequentially and a failure stops the run: a half-applied
 * fleet is easier to reason about when you know exactly where it stopped.
 */
import {Knex} from "knex";
import {getArchiveShard, getHotShard, listConfiguredRegions, destroyAllShards} from "../src/lib/knex/shards";
import {logger} from "../src/lib/logger/logger";

type Cluster = "hot" | "archive";
type Action = "latest" | "rollback" | "status" | "up" | "down";

const CLUSTERS: Cluster[] = ["hot", "archive"];
const ACTIONS: Action[] = ["latest", "rollback", "status", "up", "down"];

interface Options {
    cluster: Cluster;
    action: Action;
    region?: string;
}

function parseArgs(argv: string[]): Options {
    const opts: Options = {cluster: "hot", action: "latest"};

    for (const arg of argv) {
        const match = arg.match(/^--([a-z]+)=(.+)$/);
        if (!match) throw new Error(`Unrecognized argument "${arg}". Expected --cluster=, --action= or --region=.`);
        const [, key, value] = match;

        switch (key) {
            case "cluster":
                if (!CLUSTERS.includes(value as Cluster)) {
                    throw new Error(`--cluster must be one of ${CLUSTERS.join("|")}, got "${value}"`);
                }
                opts.cluster = value as Cluster;
                break;
            case "action":
                if (!ACTIONS.includes(value as Action)) {
                    throw new Error(`--action must be one of ${ACTIONS.join("|")}, got "${value}"`);
                }
                opts.action = value as Action;
                break;
            case "region":
                opts.region = value;
                break;
            default:
                throw new Error(`Unknown option --${key}`);
        }
    }

    return opts;
}

function resolveRegions(opts: Options): string[] {
    const configured = listConfiguredRegions(opts.cluster);
    if (!opts.region) return configured;
    if (!configured.includes(opts.region)) {
        throw new Error(
            `Region "${opts.region}" is not configured for the ${opts.cluster} cluster. Known: ${configured.join(", ")}`,
        );
    }
    return [opts.region];
}

async function runAction(conn: Knex, action: Action, region: string, cluster: Cluster): Promise<void> {
    const scope = {region, cluster};

    if (action === "status") {
        const [completed, pending] = await conn.migrate.list();
        logger.info("migration status", {
            ...scope,
            completed: (completed as Array<{name: string} | string>).map((m) =>
                typeof m === "string" ? m : m.name,
            ),
            pending: (pending as Array<{file: string}>).map((m) => m.file),
        });
        return;
    }

    if (action === "latest") {
        const [batch, applied] = await conn.migrate.latest();
        logger.info(applied.length ? "migrations applied" : "already up to date", {...scope, batch, applied});
        return;
    }

    if (action === "rollback") {
        const [batch, reverted] = await conn.migrate.rollback();
        logger.info(reverted.length ? "migrations rolled back" : "nothing to roll back", {...scope, batch, reverted});
        return;
    }

    if (action === "up") {
        const [batch, applied] = await conn.migrate.up();
        logger.info("migration stepped up", {...scope, batch, applied});
        return;
    }

    const [batch, reverted] = await conn.migrate.down();
    logger.info("migration stepped down", {...scope, batch, reverted});
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    const regions = resolveRegions(opts);

    if (regions.length === 0) {
        throw new Error(`No regions configured for the ${opts.cluster} cluster — check REGIONS in .env`);
    }

    logger.info("migrate:all starting", {action: opts.action, cluster: opts.cluster, regions});

    for (const region of regions) {
        const conn = opts.cluster === "hot" ? getHotShard(region) : getArchiveShard(region);
        try {
            await runAction(conn, opts.action, region, opts.cluster);
        } catch (err) {
            logger.error("migration failed — stopping before the remaining shards", {
                region,
                cluster: opts.cluster,
                action: opts.action,
                error: (err as Error).message,
            });
            throw err;
        }
    }

    logger.info("migrate:all done", {action: opts.action, cluster: opts.cluster, regions});
}

main()
    .then(async () => {
        await destroyAllShards();
        process.exit(0);
    })
    .catch(async (err) => {
        logger.error("migrate:all aborted", {error: (err as Error).message});
        await destroyAllShards().catch(() => {});
        process.exit(1);
    });

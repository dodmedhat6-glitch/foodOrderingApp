import "reflect-metadata";
import {container} from "../src/lib/di/container";
import {TOKENS} from "../src/lib/di/tokens";
import {destroyAll} from "../src/lib/knex/knex";
import {logger} from "../src/lib/logger/logger";
import {REGIONS} from "../src/lib/sharding/regions";
import {redisClient} from "../src/lib/cache/init";
import type {ArchivalService} from "../src/app/archival/service/archival.service";

/**
 * Runs the archival worker once, now, outside its nightly window.
 *
 *   npm run archive:now                   # every configured region
 *   npm run archive:now -- --region=eg    # one region
 *
 * Takes the same per-region Redis lock as the scheduled job, so it is safe to
 * run while a worker is up: whichever gets the lock moves the rows, the other
 * logs that it skipped. Re-running after a finished run moves nothing.
 */
async function main(): Promise<void> {
    const arg = process.argv.find((a) => a.startsWith("--region="));
    const regions = arg ? [arg.slice("--region=".length)] : [...REGIONS];

    const archival = container.resolve<ArchivalService>(TOKENS.ArchivalService);
    for (const region of regions) {
        const result = await archival.archiveRegion(region);
        console.log(JSON.stringify(result ?? {region, skipped: "locked by another run"}));
    }
}

main()
    .then(async () => {
        await destroyAll();
        redisClient.disconnect();
        process.exit(0);
    })
    .catch(async (err) => {
        logger.error("archive:now failed", {error: (err as Error).message});
        await destroyAll().catch(() => undefined);
        redisClient.disconnect();
        process.exit(1);
    });

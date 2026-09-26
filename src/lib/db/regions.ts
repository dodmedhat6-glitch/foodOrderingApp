import knex, { Knex } from 'knex';
import { env } from '../config/env';
import { buildKnexConfig } from './build-knex-config';
import { logger } from '../logger/logger';

const migrations = { directory: env.migrationsDirectory, extension: env.migrationsExtension };

const hotPools: Record<string, Knex> = {};
const archivePools: Record<string, Knex> = {};

for (const code of env.regionCodes) {
  const region = env.regions[code];
  hotPools[code] = knex(buildKnexConfig(region.hot, env.dbPoolMax, migrations));
  archivePools[code] = knex(buildKnexConfig(region.archive, env.dbPoolMax, migrations));
}

/** No "default region" fallback - an unconfigured region throws, per AGENTS.md §8. */
export function resolveRegionConnection(region: string): Knex {
  const pool = hotPools[region];
  if (!pool) {
    throw new Error(`No hot DB pool configured for region "${region}".`);
  }
  return pool;
}

export function resolveArchiveConnection(region: string): Knex {
  const pool = archivePools[region];
  if (!pool) {
    throw new Error(`No archive DB pool configured for region "${region}".`);
  }
  return pool;
}

export async function testAllPools(): Promise<Record<string, { hot: boolean; archive: boolean }>> {
  const results: Record<string, { hot: boolean; archive: boolean }> = {};
  await Promise.all(
    env.regionCodes.map(async (code) => {
      const [hot, archive] = await Promise.all([
        hotPools[code]
          .raw('select 1')
          .then(() => true)
          .catch(() => false),
        archivePools[code]
          .raw('select 1')
          .then(() => true)
          .catch(() => false),
      ]);
      results[code] = { hot, archive };
    }),
  );
  return results;
}

export async function closeAllPools(): Promise<void> {
  await Promise.all([
    ...Object.values(hotPools).map((pool) => pool.destroy()),
    ...Object.values(archivePools).map((pool) => pool.destroy()),
  ]);
  logger.info('all regional db pools closed');
}

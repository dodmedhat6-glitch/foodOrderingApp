import type { Knex } from 'knex';
import { env } from './src/lib/config/env';
import { buildKnexConfig } from './src/lib/db/build-knex-config';

const region = process.env.MIGRATE_REGION;
if (!region) {
  throw new Error(
    `Set MIGRATE_REGION=<code> to run knex CLI commands (configured: ${env.regionCodes.join(', ')}).`,
  );
}

const regionConfig = env.regions[region];
if (!regionConfig) {
  throw new Error(`Unknown MIGRATE_REGION "${region}" (configured: ${env.regionCodes.join(', ')}).`);
}

const target = process.env.MIGRATE_TARGET === 'archive' ? 'archive' : 'hot';
const conn = target === 'archive' ? regionConfig.archive : regionConfig.hot;

const config: Knex.Config = buildKnexConfig(conn, env.dbPoolMax, {
  directory: env.migrationsDirectory,
  extension: env.migrationsExtension,
});

export default config;

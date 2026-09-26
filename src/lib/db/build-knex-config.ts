import type { Knex } from 'knex';
import { ConnConfig } from '../config/env';

export interface MigrationsConfig {
  directory: string;
  extension: string;
}

export function buildKnexConfig(
  conn: ConnConfig,
  poolMax: number,
  migrations: MigrationsConfig,
): Knex.Config {
  return {
    client: 'pg',
    connection: {
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
    },
    pool: { max: poolMax },
    migrations: {
      directory: migrations.directory,
      extension: migrations.extension,
    },
  };
}

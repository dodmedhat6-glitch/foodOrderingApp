import {config} from 'dotenv';
import knex from 'knex';
import path from 'path';

/**
 * Standalone knex instance for globalSetup.
 *
 * globalSetup runs outside Jest's module registry, so the custom resolver
 * (jest.resolver.js) that maps NodeNext '.js' specifiers onto '.ts' sources is
 * not applied. Importing src/lib/knex/kenx here therefore fails on its
 * './knexConfig.js' require. Build the connection from .env.test instead.
 */
config({path: path.resolve(__dirname, '../../.env.test')});

export function migrationsDirectory(): string {
    return path.resolve(
        __dirname,
        '../..',
        process.env.DB_MIGRATIONS_DIRECTORY ?? 'src/migrations',
    );
}

export function createMigrationDb() {
    return knex({
        client: 'pg',
        connection: {
            host: process.env.DB_HOST ?? 'localhost',
            port: Number(process.env.DB_PORT ?? 5432),
            user: process.env.DB_USER ?? 'postgres',
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        },
        pool: {min: 0, max: 2},
        migrations: {
            directory: migrationsDirectory(),
            extension: process.env.DB_MIGRATIONS_EXTENSION ?? 'ts',
            loadExtensions: ['.ts'],
        },
    });
}

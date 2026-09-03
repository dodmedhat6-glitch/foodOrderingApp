import knex from "knex";
import config from './knexConfig.js'

export const db = knex(config);

export async function testDB(): Promise<void> {
    await db.raw("select 1");
}

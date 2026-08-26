import knex from "knex";
import config from './knexConfig.js'

export const db = knex(config);
export async function testDB() {
    await db.raw("SELECT 1+1 AS result");}

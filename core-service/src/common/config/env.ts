import { config } from 'dotenv';
import path from 'path/win32';
import { z } from 'zod';

config({ path: path.resolve(__dirname, '../../../.env') });

const schema = z.object({
    PORT: z.string().default("3000"),
    DB_HOST: z.string().default("localhost"),
    DB_PORT: z.string().default("5432"),
    DB_USER: z.string().default("postgres"),
    DB_PASSWORD: z.string(),
    DB_NAME: z.string(),
    DB_POOL_MAX: z.string().default("10"),
    DB_MIGRATIONS_DIRECTORY: z.string(),
    DB_MIGRATIONS_EXTENSION: z.string(),
    ACCESS_SECRET: z.string(),
    REFRESH_SECRET: z.string(),
    ACCESS_EXPIRATION: z.string(),
    REFRESH_EXPIRATION: z.string()
})

const parset = schema.parse(process.env)

export const env = {
    port: Number(parset.PORT),
    db: {
        host: parset.DB_HOST,
        port: Number(parset.DB_PORT),
        user: parset.DB_USER,
        password: parset.DB_PASSWORD,
        name: parset.DB_NAME,
        poolMax: Number(parset.DB_POOL_MAX),
        migrationsDirectory: path.resolve(__dirname, '../../../', parset.DB_MIGRATIONS_DIRECTORY),
        migrationsExtension: parset.DB_MIGRATIONS_EXTENSION

    },
    jwt: {
        refreshSecret: parset.REFRESH_SECRET,
        accessSecret: parset.ACCESS_SECRET,
        accessExpires: parset.ACCESS_EXPIRATION,
        refreshExpires: parset.REFRESH_EXPIRATION
    }
}
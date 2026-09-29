import { config } from 'dotenv';
import path from 'path';
import { z } from 'zod';

config({ path: path.resolve(__dirname, '../../../.env') });

export interface ConnConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface RegionConfig {
  id: number;
  hot: ConnConfig;
  archive: ConnConfig;
}

const regionCodes = (process.env.REGIONS ?? '')
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);

if (regionCodes.length === 0) {
  throw new Error('REGIONS env var must list at least one region/country code, e.g. "EG,SA"');
}

const regionEnvShape: Record<string, z.ZodTypeAny> = {};
for (const code of regionCodes) {
  regionEnvShape[`DB_${code}_HOST`] = z.string().default('localhost');
  regionEnvShape[`DB_${code}_PORT`] = z.string().default('5432');
  regionEnvShape[`DB_${code}_USER`] = z.string().default('postgres');
  regionEnvShape[`DB_${code}_PASSWORD`] = z.string();
  regionEnvShape[`DB_${code}_NAME`] = z.string();
  regionEnvShape[`DB_${code}_ARCHIVE_NAME`] = z.string();
}

const schema = z.object({
  PORT: z.string().default('3000'),
  DB_POOL_MAX: z.string().default('10'),
  DB_MIGRATIONS_DIRECTORY: z.string().default('src/migrations'),
  DB_MIGRATIONS_EXTENSION: z.string().default('ts'),
  ACCESS_SECRET: z.string(),
  REFRESH_SECRET: z.string(),
  ACCESS_EXPIRATION: z.string().default('15m'),
  REFRESH_EXPIRATION: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:3001'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379'),
  REDIS_PASSWORD: z.string().optional(),
  RABBIT_URL: z.string().default('amqp://localhost:5672'),
  RABBIT_EXCHANGE: z.string().default('core.events'),
  RABBIT_QUEUE: z.string().default('order-service.cache-invalidation'),
  RABBIT_BINDING_KEY: z.string().default('core.*.invalidated'),
  // Origin only, no path: CoreClient resolves request paths against it with
  // `new URL(path, baseUrl)`, and those paths already carry the "/api" prefix.
  CORE_SERVICE_BASE_URL: z.string().default('http://localhost:3000'),
  CORE_SERVICE_API_KEY: z.string(),
  ...regionEnvShape,
});

const parsed = schema.parse(process.env) as Record<string, string | undefined>;

function required(key: string): string {
  const value = parsed[key];
  if (value === undefined) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

const regions: Record<string, RegionConfig> = {};
regionCodes.forEach((code, index) => {
  regions[code] = {
    id: index,
    hot: {
      host: required(`DB_${code}_HOST`),
      port: Number(required(`DB_${code}_PORT`)),
      user: required(`DB_${code}_USER`),
      password: required(`DB_${code}_PASSWORD`),
      database: required(`DB_${code}_NAME`),
    },
    archive: {
      host: required(`DB_${code}_HOST`),
      port: Number(required(`DB_${code}_PORT`)),
      user: required(`DB_${code}_USER`),
      password: required(`DB_${code}_PASSWORD`),
      database: required(`DB_${code}_ARCHIVE_NAME`),
    },
  };
});

export const env = {
  port: Number(parsed.PORT),
  regionCodes,
  regions,
  dbPoolMax: Number(parsed.DB_POOL_MAX),
  migrationsDirectory: path.resolve(__dirname, '../../../', parsed.DB_MIGRATIONS_DIRECTORY!),
  migrationsExtension: parsed.DB_MIGRATIONS_EXTENSION!,
  jwt: {
    accessSecret: required('ACCESS_SECRET'),
    refreshSecret: required('REFRESH_SECRET'),
    accessExpires: parsed.ACCESS_EXPIRATION!,
    refreshExpires: parsed.REFRESH_EXPIRATION!,
  },
  cors: {
    origin: parsed.CORS_ORIGIN!.split(','),
  },
  redis: {
    host: parsed.REDIS_HOST!,
    port: Number(parsed.REDIS_PORT),
    password: parsed.REDIS_PASSWORD,
  },
  rabbit: {
    url: parsed.RABBIT_URL!,
    exchange: parsed.RABBIT_EXCHANGE!,
    queue: parsed.RABBIT_QUEUE!,
    bindingKey: parsed.RABBIT_BINDING_KEY!,
  },
  coreService: {
    baseUrl: parsed.CORE_SERVICE_BASE_URL!,
    apiKey: required('CORE_SERVICE_API_KEY'),
  },
  isProduction: process.env.NODE_ENV === 'production',
};

import { RedisPubSubProvider } from '../../pkg/pubsub/redis';
import { env } from '../config/env';

export const pubSubProvider = new RedisPubSubProvider({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password || undefined,
});

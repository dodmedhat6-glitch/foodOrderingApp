import Redis from 'ioredis';
import { IPubSubProvider, PubSubHandler } from './pubsub.interface';

export interface RedisPubSubConfig {
  host: string;
  port: number;
  password?: string;
}

/**
 * ioredis connections in subscribe mode can't issue other commands, so this
 * holds two dedicated connections (publisher, subscriber) - never reuses
 * pkg/cache's connection.
 */
export class RedisPubSubProvider implements IPubSubProvider {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers: Map<string, PubSubHandler[]> = new Map();

  constructor(config: RedisPubSubConfig) {
    const options = {
      host: config.host,
      port: config.port,
      password: config.password,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    };
    this.publisher = new Redis(options);
    this.subscriber = new Redis(options);

    this.publisher.on('error', (err) => console.error('Redis pubsub (publisher) error:', err));
    this.subscriber.on('error', (err) => console.error('Redis pubsub (subscriber) error:', err));

    this.publisher.connect().catch((err) => {
      console.error('Redis pubsub publisher connect error:', err);
    });
    this.subscriber.connect().catch((err) => {
      console.error('Redis pubsub subscriber connect error:', err);
    });

    this.subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
      const handlers = this.handlers.get(pattern) ?? [];
      for (const handler of handlers) {
        handler(channel, message);
      }
    });
  }

  async publish(channel: string, payload: string): Promise<void> {
    await this.publisher.publish(channel, payload);
  }

  async psubscribe(pattern: string, handler: PubSubHandler): Promise<void> {
    const existing = this.handlers.get(pattern);
    if (existing) {
      existing.push(handler);
      return;
    }
    this.handlers.set(pattern, [handler]);
    await this.subscriber.psubscribe(pattern);
  }

  async quit(): Promise<void> {
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}

import amqp from "amqp-connection-manager";
import type { AmqpConnectionManager, Channel, ChannelWrapper } from "amqp-connection-manager";
import type { ConsumeMessage } from "amqplib";
import type { ConsumedEvent, EventHandler, IEventConsumer } from "./message-broker.interface";

export interface RabbitMQConsumerConfig {
    url: string;
    exchange: string;
    queue: string;
    bindingKey: string;
    prefetch?: number;
    reconnectInitialMs?: number;
}

/**
 * Durable-queue consumer built on amqp-connection-manager, counterpart to
 * core-service's RabbitMQClient producer. The queue is bound to the shared
 * topic exchange so this process can go offline and pick up right where it
 * left off - unlike Redis Pub/Sub, nothing is dropped while nobody's
 * listening. A handler that throws nacks without requeue, so a message that
 * keeps failing lands on the dead-letter queue instead of looping forever.
 */
export class RabbitMQConsumer implements IEventConsumer {
    private connection: AmqpConnectionManager | null = null;
    private channel: ChannelWrapper | null = null;

    constructor(private readonly config: RabbitMQConsumerConfig) {}

    async connect(): Promise<void> {
        if (this.connection) return;
        this.connection = amqp.connect([this.config.url], {
            reconnectTimeInSeconds: Math.max(1, Math.round((this.config.reconnectInitialMs ?? 500) / 1000)),
        });
    }

    async consume(handler: EventHandler): Promise<void> {
        if (!this.connection) await this.connect();

        const { exchange, queue, bindingKey, prefetch = 10 } = this.config;
        const deadLetterExchange = `${exchange}.dlx`;
        const deadLetterQueue = `${queue}.dlq`;

        this.channel = this.connection!.createChannel({
            json: false,
            setup: async (ch: Channel) => {
                await ch.assertExchange(exchange, "topic", { durable: true });
                await ch.assertExchange(deadLetterExchange, "topic", { durable: true });
                await ch.assertQueue(deadLetterQueue, { durable: true });
                await ch.bindQueue(deadLetterQueue, deadLetterExchange, "#");

                await ch.assertQueue(queue, {
                    durable: true,
                    deadLetterExchange,
                });
                await ch.bindQueue(queue, exchange, bindingKey);
                await ch.prefetch(prefetch);
            },
        });

        await this.channel.waitForConnect();
        await this.channel.consume(queue, (msg: ConsumeMessage) => {
            void this.handleMessage(msg, handler);
        });
    }

    private async handleMessage(msg: ConsumeMessage, handler: EventHandler): Promise<void> {
        try {
            const event = JSON.parse(msg.content.toString("utf8")) as ConsumedEvent;
            await handler(event);
            this.channel!.ack(msg);
        } catch (err) {
            console.error("Event consumer handler failed, sending to dead-letter queue:", err);
            this.channel!.nack(msg, false, false);
        }
    }

    async close(): Promise<void> {
        try {
            if (this.channel) await this.channel.close();
        } catch {}
        try {
            if (this.connection) await this.connection.close();
        } catch {}
        this.channel = null;
        this.connection = null;
    }
}

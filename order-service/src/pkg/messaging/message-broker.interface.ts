export interface ConsumeMessage {
    routingKey: string;
    body: Buffer;
    ack(): void;
    nack(requeue?: boolean): void;
}

export interface ConsumerOptions {
    queue: string;
    exchange: string;
    bindingKeys: string[];
    deadLetterExchange?: string;
    deadLetterQueue?: string;
    prefetch: number;
}

export interface IMessageBroker {
    connect(): Promise<void>;
    close(): Promise<void>;
    declareTopology(opts: ConsumerOptions): Promise<void>;
    /**
     * Publisher-side topology: a durable topic exchange, re-asserted on every
     * reconnect. The publisher owns its exchange; consumers own their queues.
     */
    declareExchange(exchange: string): Promise<void>;
    consume(opts: ConsumerOptions, handler: (msg: ConsumeMessage) => Promise<void>): Promise<void>;
    publish(exchange: string, routingKey: string, body: Buffer): Promise<void>;
}

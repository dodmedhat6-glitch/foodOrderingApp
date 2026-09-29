export interface ConsumedEvent {
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: number | string;
  occurredAt: string;
  payload: unknown;
}

export type EventHandler = (event: ConsumedEvent) => Promise<void>;

/**
 * Consumer-side counterpart to core-service's `pkg/message-broker`
 * (RabbitMQClient/publishConfirmed). One handler per queue: return
 * normally to ack, throw to nack - a message that keeps failing lands on
 * the dead-letter queue instead of being redelivered forever.
 */
export interface IEventConsumer {
  connect(): Promise<void>;
  consume(handler: EventHandler): Promise<void>;
  close(): Promise<void>;
}

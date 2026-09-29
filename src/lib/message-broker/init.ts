import { RabbitMQConsumer } from '../../pkg/message-broker/rabbitmq-consumer';
import { env } from '../config/env';

export const eventConsumer = new RabbitMQConsumer({
  url: env.rabbit.url,
  exchange: env.rabbit.exchange,
  queue: env.rabbit.queue,
  bindingKey: env.rabbit.bindingKey,
});

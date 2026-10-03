import {RabbitMQClient} from "../../pkg/message-broker/rabbitmq";
import {env} from "../config/env";

export const messageBroker = new RabbitMQClient({url: env.rabbit.url});

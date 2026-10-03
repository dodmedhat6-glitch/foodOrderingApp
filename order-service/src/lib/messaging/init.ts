import {RabbitMQClient} from "../../pkg/messaging/rabbitmq/rabbitmq.client";
import {env} from "../config/env";
import {logger} from "../logger/logger";

export const messageBroker = new RabbitMQClient({
    url: env.rabbit.url,
    reconnectInitialMs: 500,
    reconnectMaxMs: 15_000,

    // Connection state is the only way an operator can tell a healthy boot
    // from one where the broker was never reachable: `connect()` waits
    // indefinitely while amqp-connection-manager retries, so nothing else logs.
    // Disconnects are `warn` rather than `error` — the client recovers on its
    // own and re-declares topology, so this is noteworthy, not actionable.
    onStateChange: (state, detail) => {
        if (state === "connected") {
            logger.info("rabbitmq connected", {url: env.rabbit.url});
        } else {
            logger.warn("rabbitmq disconnected — retrying", {error: detail});
        }
    },
});

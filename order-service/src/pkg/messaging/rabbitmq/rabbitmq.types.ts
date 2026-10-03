export interface RabbitMQConfig {
    url: string;
    reconnectInitialMs: number; // first backoff, doubles up to reconnectMaxMs
    reconnectMaxMs: number;

    /**
     * Called on every connect and every disconnect, including the failed
     * attempts while the broker is down.
     *
     * The reason this exists: `connect()` resolves only once a connection is
     * actually established, and amqp-connection-manager retries forever — so
     * with no broker running it neither resolves nor rejects, and a caller
     * awaiting it learns nothing. Without this hook the service boots
     * perfectly quietly with no consumer attached.
     *
     * A callback rather than a logger because `pkg/` must stay app-agnostic
     * (CLAUDE.md s3); `lib/messaging/init.ts` passes one that logs.
     */
    onStateChange?: (state: "connected" | "disconnected", detail?: string) => void;
}

import type {Server as IOServer} from "socket.io";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {logger} from "../logger/logger";

/**
 * Publishes a domain event to socket.io rooms.
 *
 * Channel names are built here rather than inline at call sites so they can
 * never drift from the ones `ws-auth.permittedChannels` authorizes — a
 * mismatch is invisible at runtime (the emit just reaches nobody).
 *
 * Fan-out across workers is the Redis adapter's job: a single `io.to(room)`
 * call on this process reaches sockets held by every other process in the
 * region (lib/websocket/ws-server.ts).
 */

export const wsChannels = {
    customer: (userId: number) => `customer:${userId}`,
    restaurant: (restaurantId: number) => `restaurant:${restaurantId}`,
    branch: (branchId: number) => `branch:${branchId}`,
    agent: (agentId: number) => `agent:${agentId}`,
};

/**
 * Never throws and never rejects. A broadcast is a notification about a
 * transition that has already committed; failing the HTTP request because a
 * socket emit went wrong would be strictly worse than the client learning
 * about the change on its next poll or reconnect.
 */
export function wsPublish(channels: string[], event: string, payload: unknown): void {
    if (channels.length === 0) return;

    try {
        // Resolved per call rather than at module load: the io instance is
        // registered by server.ts after the HTTP server exists, and scripts
        // and workers import services without a WS server at all.
        if (!container.isRegistered(TOKENS.WsServer)) return;

        const io = container.resolve<IOServer>(TOKENS.WsServer);
        io.to(channels).emit(event, payload);
    } catch (err) {
        logger.warn("ws publish failed", {event, channels, error: (err as Error).message});
    }
}

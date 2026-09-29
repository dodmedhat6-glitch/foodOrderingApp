import type { Server as HttpServer } from 'http';
import { WsGateway } from '../../pkg/ws-gateway/ws-gateway';
import { verifyAccessToken, JwtPayload } from '../auth/jwt';

/**
 * Wires the shared WebSocket adapter to this service's HTTP server.
 *
 * Cross-instance fan-out is NOT wired up: the Redis Pub/Sub bridge that used
 * to forward `orders:status:*` into the gateway was removed when Redis was
 * narrowed to caching only. Nothing published on that channel yet, so no
 * behaviour was lost - but with more than one instance running, a
 * `gateway.publish(...)` only reaches clients connected to that same
 * instance. Re-introduce fan-out over RabbitMQ (one exclusive queue per
 * instance, not the shared round-robin queue) before scaling out.
 */
export function initWsGateway(httpServer: HttpServer): WsGateway<JwtPayload> {
  return new WsGateway<JwtPayload>({
    server: httpServer,
    verifyToken: (token) => {
      try {
        return verifyAccessToken(token);
      } catch {
        return null;
      }
    },
  });
}

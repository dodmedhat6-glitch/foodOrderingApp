import type { Server as HttpServer } from 'http';
import { WsGateway } from '../../pkg/ws-gateway/ws-gateway';
import { verifyAccessToken, JwtPayload } from '../auth/jwt';
import { pubSubProvider } from '../pubsub/init';
import { logger } from '../logger/logger';

export function initWsGateway(httpServer: HttpServer): WsGateway<JwtPayload> {
  const gateway = new WsGateway<JwtPayload>({
    server: httpServer,
    verifyToken: (token) => {
      try {
        return verifyAccessToken(token);
      } catch {
        return null;
      }
    },
  });

  pubSubProvider
    .psubscribe('orders:status:*', (channel, message) => {
      const orderId = channel.split(':')[2];
      if (!orderId) return;
      try {
        gateway.publish(`order:${orderId}`, JSON.parse(message));
      } catch {
        logger.warn('ws-gateway: dropped non-JSON message', { channel });
      }
    })
    .catch((err: unknown) => {
      logger.error('ws-gateway: failed to subscribe to orders:status:*', { error: String(err) });
    });

  return gateway;
}

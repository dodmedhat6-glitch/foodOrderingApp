import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';

export interface WsGatewayOptions<TPayload> {
  server: HttpServer;
  path?: string;
  verifyToken: (token: string) => TPayload | null;
}

interface ClientMessage {
  type: 'subscribe' | 'unsubscribe';
  topic: string;
}

/**
 * Generic WebSocket base any service can instantiate for itself - zero
 * order-service domain knowledge (topics are opaque strings). See
 * 01-system-design.md §5.2. Copy-pasteable into another service unchanged.
 */
export class WsGateway<TPayload = unknown> {
  private readonly wss: WebSocketServer;
  private readonly topics: Map<string, Set<WebSocket>> = new Map();
  private readonly verifyToken: (token: string) => TPayload | null;

  constructor(options: WsGatewayOptions<TPayload>) {
    this.verifyToken = options.verifyToken;
    this.wss = new WebSocketServer({ server: options.server, path: options.path ?? '/ws' });

    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request);
    });
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    const payload = token ? this.verifyToken(token) : null;

    if (!payload) {
      socket.close(4401, 'unauthorized');
      return;
    }

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'subscribe') {
        this.subscribe(socket, message.topic);
      } else if (message.type === 'unsubscribe') {
        this.unsubscribe(socket, message.topic);
      }
    });

    socket.on('close', () => {
      for (const sockets of this.topics.values()) {
        sockets.delete(socket);
      }
    });
  }

  private subscribe(socket: WebSocket, topic: string): void {
    if (!topic) return;
    let sockets = this.topics.get(topic);
    if (!sockets) {
      sockets = new Set();
      this.topics.set(topic, sockets);
    }
    sockets.add(socket);
  }

  private unsubscribe(socket: WebSocket, topic: string): void {
    this.topics.get(topic)?.delete(socket);
  }

  publish(topic: string, payload: unknown): void {
    const sockets = this.topics.get(topic);
    if (!sockets || sockets.size === 0) return;
    const message = JSON.stringify({ topic, payload });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }

  topicSubscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

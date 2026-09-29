export const tokens = {
  // infra
  Logger: Symbol.for('Logger'),

  // cache (Redis is caching only - events go over RabbitMQ)
  CacheProvider: Symbol.for('CacheProvider'),

  // cross-service
  CoreClient: Symbol.for('CoreClient'),

  // real-time
  WsGateway: Symbol.for('WsGateway'),

  // auth
  PermissionChecker: Symbol.for('PermissionChecker'),
};

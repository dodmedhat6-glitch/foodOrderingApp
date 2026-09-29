export const tokens = {
  // infra
  Logger: Symbol.for('Logger'),

  // cache / pubsub
  CacheProvider: Symbol.for('CacheProvider'),
  PubSubProvider: Symbol.for('PubSubProvider'),

  // cross-service
  CoreClient: Symbol.for('CoreClient'),

  // real-time
  WsGateway: Symbol.for('WsGateway'),

  // auth
  PermissionChecker: Symbol.for('PermissionChecker'),
};

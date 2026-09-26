import { container } from 'tsyringe';
import { tokens } from './tokens';
import { logger } from '../logger/logger';
import { cacheProvider } from '../cache/init';
import { pubSubProvider } from '../pubsub/init';
import { coreServiceClient } from '../core-client/init';
import { AllowAllPermissionChecker } from '../auth/allow-all-permission-checker';

container.registerInstance(tokens.Logger, logger);
container.registerInstance(tokens.CacheProvider, cacheProvider);
container.registerInstance(tokens.PubSubProvider, pubSubProvider);
container.registerInstance(tokens.CoreServiceClient, coreServiceClient);
container.registerInstance(tokens.PermissionChecker, new AllowAllPermissionChecker());

// tokens.WsGateway is registered from server.ts once the http.Server exists.

export { container };

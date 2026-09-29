import { container } from 'tsyringe';
import { tokens } from './tokens';
import { logger } from '../logger/logger';
import { cacheProvider } from '../cache/init';
import { coreClient } from '../core-client/core-client';
import { AllowAllPermissionChecker } from '../auth/allow-all-permission-checker';

container.registerInstance(tokens.Logger, logger);
container.registerInstance(tokens.CacheProvider, cacheProvider);
container.registerInstance(tokens.CoreClient, coreClient);
container.registerInstance(tokens.PermissionChecker, new AllowAllPermissionChecker());

// tokens.WsGateway is registered from server.ts once the http.Server exists.

export { container };

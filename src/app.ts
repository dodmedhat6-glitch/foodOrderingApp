import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { router } from './routes';
import { errorHandler } from './lib/error/errorHandler';
import { correlationIdMiddleware } from './lib/correlationId/correlationId';
import { env } from './lib/config/env';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.cors.origin, credentials: true }));
  app.set('query parser', 'extended');
  app.use(express.json());
  app.use(cookieParser());
  app.use(correlationIdMiddleware);
  app.use('/api', router);
  app.use(errorHandler);
  return app;
}

import { Router } from 'express';
import { healthRouter } from './app/health/health.router';

export const router = Router();

router.use('/health', healthRouter);

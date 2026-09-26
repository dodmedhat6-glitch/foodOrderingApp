import { AppError } from '../error/AppError';

export const NotAuthenticatedError = new AppError('unauthenticated', 401);
export const ForbiddenError = new AppError('forbidden', 403);

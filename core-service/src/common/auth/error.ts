import { AppError } from '../error/AppError'

export const NotAuthenticated = new AppError('unauthenticated', 401);
export const UnAuthorisedError = new AppError('UnAuthorisedError', 403);

import { AppError } from '../error/AppError'

export const NotAuthenticated = new AppError('unauthenticated', 401)
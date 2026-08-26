import { AppError } from '../../common/error/AppError'

export const UserNotFound = new AppError("User Not Found", 401)
from lib.errors.apperror import AppError

ERR_UNAUTHENTICATED = AppError("UNAUTHENTICATED", 401, "User not authenticated")
ERR_PERMISSION_DENIED = AppError("PERMISSION_DENIED", 403, "Permission denied")

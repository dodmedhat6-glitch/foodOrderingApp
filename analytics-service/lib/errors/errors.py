"""Cross-cutting errors — the ones no single module owns."""

from lib.errors.apperror import AppError

ERR_VALIDATION = AppError("VALIDATION_ERROR", 400, "Request validation failed")
ERR_NOT_FOUND = AppError("NOT_FOUND", 404, "Route not found")
ERR_METHOD_NOT_ALLOWED = AppError("METHOD_NOT_ALLOWED", 405, "Method not allowed")
ERR_INTERNAL = AppError("INTERNAL_ERROR", 500, "Something went wrong")

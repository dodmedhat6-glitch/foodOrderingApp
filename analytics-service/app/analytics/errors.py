from lib.errors.apperror import AppError

ERR_INVALID_DATE_RANGE = AppError("ANALYTICS_INVALID_DATE_RANGE", 400, "`from` must be on or before `to`")
ERR_DATE_RANGE_TOO_LARGE = AppError(
    "ANALYTICS_DATE_RANGE_TOO_LARGE", 400, "The requested date range is too large"
)
#: An event whose payload does not match the contract. Never reaches HTTP — it
#: dead-letters the message — but it is an AppError like everything else so
#: the log line carries a stable code.
ERR_INVALID_EVENT_PAYLOAD = AppError(
    "ANALYTICS_INVALID_EVENT_PAYLOAD", 422, "Event payload does not match its contract"
)

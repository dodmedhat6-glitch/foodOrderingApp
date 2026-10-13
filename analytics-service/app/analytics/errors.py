from lib.errors import AppError

ERR_INVALID_DATE_RANGE = AppError("ANALYTICS_INVALID_DATE_RANGE", 400, "`from` must be on or before `to`")
ERR_DATE_RANGE_TOO_LARGE = AppError(
    "ANALYTICS_DATE_RANGE_TOO_LARGE", 400, "The requested date range is too large"
)
# Never an HTTP response: logged when an event is dead-lettered.
ERR_INVALID_EVENT_PAYLOAD = AppError(
    "ANALYTICS_INVALID_EVENT_PAYLOAD", 422, "Event payload does not match its contract"
)

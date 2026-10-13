from lib.errors.apperror import AppError

#: Core is down, slow, or 5xx-ing after retries. A 503 to our caller: their
#: request was fine, and the same request will work once core is back.
ERR_CORE_UNAVAILABLE = AppError("CORE_UNAVAILABLE", 503, "core-service is unavailable")

#: Core answered, but not with something we can use (a 4xx we did not expect,
#: or a body that does not match the contract). A 502: the bad answer came
#: from upstream, not from our caller.
ERR_CORE_BAD_RESPONSE = AppError("CORE_BAD_RESPONSE", 502, "core-service returned an unexpected response")

import {AppError} from "../error/AppError";

export function coreUnavailableError(status: number): AppError {
    return new AppError(`core-service ${status}`, 503);
}

/**
 * A non-2xx, non-5xx reply from core. The status is passed through (a 404 on a
 * branch lookup is a 404 to our caller, not a 500) and core's parsed body is
 * carried in `upstream` so callers that need the specifics — reserve-stock's
 * per-item 409, say — can read them instead of re-parsing a string.
 */
export function coreUpstreamError(status: number, body: unknown): AppError {
    const summary = typeof body === "string" ? body : JSON.stringify(body);
    return new AppError(`core-service ${status}: ${summary}`, status, true, {upstream: body});
}

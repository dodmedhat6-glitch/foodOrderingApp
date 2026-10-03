export class AppError extends Error {
    statusCode: number;
    isOperational: boolean;
    /**
     * Structured specifics a caller can act on, merged into the error body by
     * errorHandler - the offending lines of a failed stock reservation, say.
     * Optional: an error with a stable message and nothing to add omits it.
     */
    details?: Record<string, unknown>;

    constructor(message: string, statusCode: number = 500, isOperational: boolean = true, details?: Record<string, unknown>) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.details = details;

        Error.captureStackTrace(this, this.constructor);
    }
}

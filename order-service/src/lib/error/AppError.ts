export class AppError extends Error {
    statusCode: number;
    isOperational: boolean;
    /**
     * Extra fields merged into the error response body by `errorHandler`.
     * Some contracts carry machine-readable context next to the message —
     * `OutOfStock` ships the offending lines, `InvalidStatusTransition` ships
     * the rejected edge (docs/api-contracts.md s1). Keep it to data the client
     * is meant to act on; it is serialized to the caller verbatim.
     */
    details?: Record<string, unknown>;

    constructor(
        message: string,
        statusCode: number = 500,
        isOperational: boolean = true,
        details?: Record<string, unknown>,
    ) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.details = details;

        Error.captureStackTrace(this, this.constructor);
    }
}

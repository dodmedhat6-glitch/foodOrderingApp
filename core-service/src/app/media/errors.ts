import {AppError} from "../../lib/error/AppError";

export const MediaNotFoundError = new AppError('Media not found', 404);
export const MediaFileRequiredError = new AppError('A file is required', 400);
export const MediaUploadFailedError = new AppError('Media upload failed', 502);
export const MediaNotPendingError = new AppError('Media is not awaiting an upload', 409);

export const UnsupportedMediaTypeError = (received: string, allowed: string[]) =>
    new AppError(`Unsupported media type: ${received}`, 415, true, {allowed});

export const MediaTooLargeError = (maxBytes: number) =>
    new AppError('File is too large', 413, true, {maxBytes});

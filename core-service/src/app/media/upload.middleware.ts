import {NextFunction, Request, Response} from "express";
import multer from "multer";
import {env} from "../../lib/config/env";
import {ALLOWED_CONTENT_TYPES} from "./service/media.service";
import {MediaTooLargeError, UnsupportedMediaTypeError} from "./errors";
import {AppError} from "../../lib/error/AppError";

/**
 * Multipart parsing for the direct-upload route. memoryStorage: the file goes
 * straight to S3 and is never needed on local disk, and the size limit below
 * keeps the buffer bounded.
 */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: env.media.maxUploadBytes,
        files: 1
    },
    fileFilter: (_req, file, cb) => {
        if (!ALLOWED_CONTENT_TYPES.includes(file.mimetype)) {
            return cb(UnsupportedMediaTypeError(file.mimetype, ALLOWED_CONTENT_TYPES));
        }
        cb(null, true);
    }
});

/**
 * `file` field, plus translation of multer's own errors into AppErrors -
 * a MulterError reaching errorHandler has no statusCode and would be reported
 * as a 500 rather than a 413/400.
 */
export function uploadSingleMedia(fieldName: string = 'file') {
    const handler = upload.single(fieldName);

    return (req: Request, res: Response, next: NextFunction) => {
        handler(req, res, (err: unknown) => {
            if (!err) {
                return next();
            }
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return next(MediaTooLargeError(env.media.maxUploadBytes));
                }
                return next(new AppError(err.message, 400));
            }
            return next(err);
        });
    };
}

import path from "path";
import {randomUUID} from "crypto";
import {inject, injectable} from "tsyringe";
import {MediaEntity} from "../entity/media.entity";
import {MediaStatus} from "../enums";
import {
    MediaFileRequiredError,
    MediaNotFoundError,
    MediaNotPendingError,
    MediaTooLargeError,
    MediaUploadFailedError,
    UnsupportedMediaTypeError
} from "../errors";
import {
    createMedia,
    findMediaById,
    findMediaByRestaurant,
    updateMediaStatus,
    updateMediaUpload
} from "../repository/media.repo";
import {CreateMediaUploadUrlDTO} from "../dto/media.dto";
import {tokens} from "../../../lib/di/tokens";
import {IStorageProvider} from "../../../pkg/storage/storage.interface";
import {buildPaginationResult, FilterParams, PaginationParams} from "../../../lib/http/pagination/cursor.pagination";
import {UnAuthorisedError} from "../../../lib/auth/error";
import {SystemRole} from "../../user/enums";
import {env} from "../../../lib/config/env";
import {logger} from "../../../lib/logger/logger";

/** What the module accepts into the bucket. Narrow by design - this is a menu/logo store. */
export const ALLOWED_CONTENT_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif'
];

/**
 * Top-level directory inside the bucket every upload lands under:
 *   restaurant/<restaurantId>/<uuid>.<ext>
 * One prefix for all restaurant media keeps the bucket's root tidy and leaves
 * room for other prefixes later (exports, backups) without a migration.
 */
export const MEDIA_KEY_PREFIX = 'restaurant';

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif'
};

/** The shape multer's memoryStorage hands us, without depending on its types here. */
export interface UploadedFile {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}

export interface MediaCaller {
    userId: number;
    role: SystemRole;
    restaurantId?: number;
}

export interface MediaResponse {
    id: number;
    restaurantId: number;
    uploadedBy: number;
    status: MediaStatus;
    mediaPath: string;
    mediaURL: string | null;
    contentType: string;
    sizeBytes: number;
    createdAt: Date;
}

@injectable()
export class MediaService {

    constructor(@inject(tokens.StorageProvider) private readonly storage: IStorageProvider) {
    }

    /**
     * Direct upload: the bytes arrive on the request and we proxy them to S3.
     * The row is written first (pending) so a failed PUT still leaves a record
     * of the attempt, then settled to ready/failed.
     */
    upload = async (restaurantId: number, caller: MediaCaller, file?: UploadedFile): Promise<MediaResponse> => {
        if (!file) {
            throw MediaFileRequiredError;
        }
        this.assertContentType(file.mimetype);
        if (file.size > env.media.maxUploadBytes) {
            throw MediaTooLargeError(env.media.maxUploadBytes);
        }

        const media = await createMedia(new MediaEntity({
            restaurantId,
            uploadedBy: caller.userId,
            status: MediaStatus.PENDING,
            mediaPath: this.buildKey(restaurantId, file.originalname, file.mimetype),
            contentType: file.mimetype,
            sizeBytes: file.size,
            createdAt: new Date()
        }));

        try {
            await this.storage.putObject({
                key: media.mediaPath,
                body: file.buffer,
                contentType: file.mimetype
            });
        } catch (error) {
            await updateMediaStatus(media.id, MediaStatus.FAILED);
            // The S3 error is the only thing that says *why* (bad credentials,
            // missing bucket, denied PutObject). The client gets a flat 502, so
            // without this line the cause is lost entirely.
            logger.error("S3 upload failed", {
                mediaId: media.id,
                key: media.mediaPath,
                reason: (error as Error)?.name,
                detail: (error as Error)?.message
            });
            throw MediaUploadFailedError;
        }

        const ready = await updateMediaStatus(media.id, MediaStatus.READY) ?? media;
        return this.toResponse(ready);
    }

    /**
     * Presigned upload: no bytes pass through core-service. The row stays
     * `pending` until the client calls confirmUpload() - an abandoned upload is
     * therefore visible rather than silently missing.
     */
    createUploadUrl = async (restaurantId: number, caller: MediaCaller, data: CreateMediaUploadUrlDTO) => {
        this.assertContentType(data.contentType);
        if (data.sizeBytes !== undefined && data.sizeBytes > env.media.maxUploadBytes) {
            throw MediaTooLargeError(env.media.maxUploadBytes);
        }

        const media = await createMedia(new MediaEntity({
            restaurantId,
            uploadedBy: caller.userId,
            status: MediaStatus.PENDING,
            mediaPath: this.buildKey(restaurantId, data.fileName, data.contentType),
            contentType: data.contentType,
            sizeBytes: data.sizeBytes ?? 0,
            createdAt: new Date()
        }));

        const uploadUrl = await this.storage.getSignedUploadUrl({
            key: media.mediaPath,
            contentType: data.contentType
        });

        return {media: await this.toResponse(media), uploadUrl};
    }

    /** Marks a presigned upload complete. Idempotent for rows already ready. */
    confirmUpload = async (id: number, caller: MediaCaller): Promise<MediaResponse> => {
        const media = await this.findOwned(id, caller);
        if (media.status === MediaStatus.READY) {
            return this.toResponse(media);
        }
        if (media.status !== MediaStatus.PENDING) {
            throw MediaNotPendingError;
        }
        const updated = await updateMediaUpload(id, {status: MediaStatus.READY}) ?? media;
        return this.toResponse(updated);
    }

    findById = async (id: number, caller: MediaCaller): Promise<MediaResponse> => {
        const media = await this.findOwned(id, caller);
        return this.toResponse(media);
    }

    findByRestaurant = async (restaurantId: number, params: PaginationParams, filters: FilterParams[]) => {
        const rows = await findMediaByRestaurant(restaurantId, params, filters);
        const result = buildPaginationResult(rows, params.limit, params.sortBy);
        return {
            meta: result.meta,
            data: await Promise.all(result.data.map((media) => this.toResponse(media)))
        };
    }

    /**
     * Removes the object and tombstones the row: other tables reference media
     * by id (a product image, a restaurant logo), so a hard delete would break
     * those references and lose who uploaded what.
     */
    remove = async (id: number, caller: MediaCaller): Promise<MediaResponse> => {
        const media = await this.findOwned(id, caller);
        if (media.status === MediaStatus.DELETED) {
            return this.toResponse(media);
        }
        await this.storage.deleteObject(media.mediaPath);
        const updated = await updateMediaStatus(id, MediaStatus.DELETED) ?? media;
        return this.toResponse(updated);
    }

    /**
     * `/media/:id` routes carry no restaurantId, so requireRestaurantMember
     * cannot run on them - ownership is checked here instead, the same way
     * ProductService checks a product's restaurant.
     */
    private findOwned = async (id: number, caller: MediaCaller): Promise<MediaEntity> => {
        const media = await findMediaById(id);
        if (!media) {
            throw MediaNotFoundError;
        }
        if (caller.role !== SystemRole.SYSTEM_ADMIN && Number(media.restaurantId) !== Number(caller.restaurantId)) {
            throw UnAuthorisedError;
        }
        return media;
    }

    /** A signed GET url, minted per read - only for objects actually in the bucket. */
    private toResponse = async (media: MediaEntity): Promise<MediaResponse> => {
        const mediaURL = media.status === MediaStatus.READY
            ? await this.storage.getSignedDownloadUrl(media.mediaPath)
            : null;

        return {
            id: media.id,
            restaurantId: media.restaurantId,
            uploadedBy: media.uploadedBy,
            status: media.status,
            mediaPath: media.mediaPath,
            mediaURL,
            contentType: media.contentType,
            sizeBytes: media.sizeBytes,
            createdAt: media.createdAt
        };
    }

    private assertContentType = (contentType: string): void => {
        if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
            throw UnsupportedMediaTypeError(contentType, ALLOWED_CONTENT_TYPES);
        }
    }

    /**
     * Keys are uuid-based, never the caller's filename: two restaurants
     * uploading `logo.png` must not collide, and the original name is not
     * trusted as a path segment.
     */
    private buildKey = (restaurantId: number, fileName: string, contentType: string): string => {
        const extension = EXTENSION_BY_CONTENT_TYPE[contentType]
            ?? (path.extname(fileName || '').toLowerCase() || '');
        return `${MEDIA_KEY_PREFIX}/${restaurantId}/${randomUUID()}${extension}`;
    }
}

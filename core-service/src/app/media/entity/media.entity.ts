import {MediaStatus} from "../enums";

export class MediaEntity {
    id: number;
    restaurantId: number;
    uploadedBy: number;
    status: MediaStatus;
    /**
     * The S3 object key (restaurant/<restaurantId>/<uuid>.<ext>), not a
     * URL: the bucket is private, so a browser-usable URL is a signed one
     * minted per read (MediaService.toResponse). Storing the key keeps those
     * URLs from going stale in the database.
     */
    mediaPath: string;
    contentType: string;
    sizeBytes: number;
    createdAt: Date;

    constructor(data: Partial<MediaEntity>) {
        this.id = data.id!;
        this.restaurantId = data.restaurantId!;
        this.uploadedBy = data.uploadedBy!;
        this.status = data.status!;
        this.mediaPath = data.mediaPath!;
        this.contentType = data.contentType ?? '';
        this.sizeBytes = data.sizeBytes ?? 0;
        this.createdAt = data.createdAt ?? new Date();
    }
}

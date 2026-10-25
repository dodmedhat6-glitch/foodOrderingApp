export enum MediaStatus {
    /** Row created, bytes not in the bucket yet (presigned-upload flow). */
    PENDING = 'pending',
    /** Object is in the bucket and servable. */
    READY = 'ready',
    /** The upload failed; the row is kept so the attempt is traceable. */
    FAILED = 'failed',
    /** Object removed from the bucket; the row is kept as a tombstone. */
    DELETED = 'deleted'
}

/**
 * Object storage, as core-service uses it. Narrow on purpose: an upload, a
 * read-back URL, a presigned PUT for the browser-direct path, and a delete.
 * The S3 implementation lives next to this file (s3.ts); app code depends on
 * the interface through tokens.StorageProvider, never on the SDK.
 */

export interface PutObjectInput {
    /** Object key, without a leading slash - e.g. restaurant/7/<uuid>.jpg */
    key: string;
    body: Buffer;
    contentType: string;
}

export interface SignedUploadInput {
    key: string;
    contentType: string;
    expiresInSeconds?: number;
}

export interface StoredObject {
    key: string;
}

export interface IStorageProvider {
    /** Uploads the bytes and resolves with the stored object's key. */
    putObject(input: PutObjectInput): Promise<StoredObject>;

    /** Removes the object. Resolves even if the key is already gone. */
    deleteObject(key: string): Promise<void>;

    /** Time-limited GET URL, for handing a private object to a client. */
    getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;

    /** Time-limited PUT URL, so a client can upload without proxying bytes through us. */
    getSignedUploadUrl(input: SignedUploadInput): Promise<string>;
}

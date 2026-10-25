import { IStorageProvider } from "../../pkg/storage/storage.interface";
import { S3StorageProvider } from "../../pkg/storage/s3";
import { env } from "../config/env";

let provider: IStorageProvider | undefined

/**
 * Built on first call, not at import time: constructing it reads env.s3, which
 * is what validates the AWS credentials. Keeping that off the import path lets
 * the DI container (and so anything importing it) load without them.
 */
export function getStorageProvider(): IStorageProvider {
    if (provider === undefined) {
        provider = new S3StorageProvider({
            region: env.s3.region,
            bucket: env.s3.bucket,
            accessKeyId: env.s3.accessKeyId,
            secretAccessKey: env.s3.secretAccessKey,
            signedUrlExpiresIn: env.s3.signedUrlExpiresIn,
        });
    }
    return provider
}

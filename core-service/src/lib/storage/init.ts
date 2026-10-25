import { S3StorageProvider } from "../../pkg/storage/s3";
import { env } from "../config/env";

export const storageProvider = new S3StorageProvider({
    region: env.s3.region,
    bucket: env.s3.bucket,
    accessKeyId: env.s3.accessKeyId,
    secretAccessKey: env.s3.secretAccessKey,
    signedUrlExpiresIn: env.s3.signedUrlExpiresIn,
});

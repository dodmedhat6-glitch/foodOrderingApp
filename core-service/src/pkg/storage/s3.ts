import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
    IStorageProvider,
    PutObjectInput,
    SignedUploadInput,
    StoredObject,
} from "./storage.interface";

export interface S3Config {
    region: string;
    /** Bucket name, not an ARN - see env.s3.bucket, which strips the arn prefix. */
    bucket: string;
    /** Static keys for local development only; omit on AWS to use the instance/task role. */
    accessKeyId?: string;
    secretAccessKey?: string;
    /** Default lifetime for presigned URLs, in seconds. */
    signedUrlExpiresIn?: number;
}

const DEFAULT_SIGNED_URL_EXPIRES_IN = 900; // 15 minutes

export class S3StorageProvider implements IStorageProvider {
    private readonly client: S3Client;
    private readonly bucket: string;
    private readonly signedUrlExpiresIn: number;

    constructor(config: S3Config) {
        // Both keys set -> use them (developer machine). Otherwise let the SDK
        // resolve credentials itself: env vars, ~/.aws, then the EC2 instance
        // role / ECS task role through the metadata endpoint.
        const staticCredentials = config.accessKeyId && config.secretAccessKey
            ? {accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey}
            : undefined;
        this.client = new S3Client({
            region: config.region,
            ...(staticCredentials ? {credentials: staticCredentials} : {}),
        });
        this.bucket = config.bucket;
        this.signedUrlExpiresIn = config.signedUrlExpiresIn ?? DEFAULT_SIGNED_URL_EXPIRES_IN;
    }

    putObject = async (input: PutObjectInput): Promise<StoredObject> => {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            Body: input.body,
            ContentType: input.contentType,
        }));
        return { key: input.key };
    }

    deleteObject = async (key: string): Promise<void> => {
        // S3 DELETE is idempotent: a missing key is a 204, not an error.
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
        }));
    }

    getSignedDownloadUrl = async (key: string, expiresInSeconds?: number): Promise<string> => {
        return getSignedUrl(
            this.client,
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
            { expiresIn: expiresInSeconds ?? this.signedUrlExpiresIn },
        );
    }

    getSignedUploadUrl = async (input: SignedUploadInput): Promise<string> => {
        return getSignedUrl(
            this.client,
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: input.key,
                ContentType: input.contentType,
            }),
            { expiresIn: input.expiresInSeconds ?? this.signedUrlExpiresIn },
        );
    }
}

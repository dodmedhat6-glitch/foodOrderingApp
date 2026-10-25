import {IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min} from "class-validator";
import {Type} from "class-transformer";
import {MediaStatus} from "../enums";

/**
 * Presigned-upload flow: the client declares what it is about to upload, gets
 * back a PUT url, then calls the confirm endpoint. Direct multipart uploads
 * carry nobody DTO - the file itself is the payload (see routes.ts).
 */
export class CreateMediaUploadUrlDTO {
    @IsString()
    @IsNotEmpty()
    fileName!: string;

    @IsString()
    @IsNotEmpty()
    contentType!: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    sizeBytes?: number;
}

export class UpdateMediaStatusDTO {
    @IsEnum(MediaStatus)
    status!: MediaStatus;
}

export class SignedUrlQueryDTO {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(60)
    @Max(604800) // S3 caps presigned (sigv4) urls at 7 days
    expiresIn?: number;
}

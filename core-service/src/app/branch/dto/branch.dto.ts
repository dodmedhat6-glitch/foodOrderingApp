import {IsString, IsNotEmpty, IsNumber, IsInt, Min, IsEnum, IsOptional, IsBoolean, Max, Matches} from "class-validator";
import {Currency} from "../enums";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class CreateBranchDTO {
    @IsString()
    @IsNotEmpty()
    countryCode!: string;

    @IsString()
    @IsNotEmpty()
    label!: string;

    @IsString()
    @IsNotEmpty()
    addressText!: string;

    @IsNumber()
    lat!: number;

    @IsNumber()
    lng!: number;

    @IsString()
    @Matches(TIME_PATTERN, {message: "opensAt must be a time string in HH:mm or HH:mm:ss format"})
    opensAt!: string;

    @IsString()
    @Matches(TIME_PATTERN, {message: "closesAt must be a time string in HH:mm or HH:mm:ss format"})
    closesAt!: string;

    @IsInt()
    @Min(0)
    deliveryRadius!: number;

    @IsEnum(Currency)
    currency!: Currency
}

export class UpdateBranchDTO {
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    label?: string;

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    addressText?: string;

    @IsOptional()
    @IsNumber()
    lat?: number;

    @IsOptional()
    @IsNumber()
    lng?: number;

    @IsOptional()
    @IsString()
    @Matches(TIME_PATTERN, {message: "opensAt must be a time string in HH:mm or HH:mm:ss format"})
    opensAt?: string;

    @IsOptional()
    @IsString()
    @Matches(TIME_PATTERN, {message: "closesAt must be a time string in HH:mm or HH:mm:ss format"})
    closesAt?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    deliveryRadius?: number;

    @IsOptional()
    @IsEnum(Currency)
    currency?: Currency

    @IsOptional()
    @IsBoolean()
    acceptOrders?: boolean;
}

export class UpdateBranchStatusDTO {
    @IsOptional()
    @IsBoolean()
    isActive?: boolean;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(100)
    commission?: number;
}

import {Type} from "class-transformer";
import {IsString, IsNotEmpty, IsOptional, IsEnum, IsEmail, MinLength, MaxLength, IsStrongPassword, ValidateNested} from "class-validator";
import {RestaurantStatus} from "../enums";

export class CreateRestaurantOwnerDTO {
    @IsEmail()
    email!: string;

    @MinLength(10)
    @MaxLength(11)
    phone!: string;

    @IsString()
    @MinLength(1)
    name!: string;

    @IsStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1,
        minSymbols: 1,
    }, {
        message: 'Password is not strong enough. It must contain at least 8 characters, one uppercase letter, one lowercase letter, one number.',
    })
    password!: string;
}

export class CreateRestaurantDTO {
    @ValidateNested()
    @Type(() => CreateRestaurantOwnerDTO)
    owner!: CreateRestaurantOwnerDTO;

    @IsString()
    @IsNotEmpty()
    name!: string;

    @IsOptional()
    @IsString()
    logoUrl?: string;

    @IsString()
    @IsNotEmpty()
    primaryCountry!: string;
}

export class UpdateRestaurantDTO {
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    name?: string;

    @IsOptional()
    @IsString()
    logoUrl?: string;

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    primaryCountry?: string;
}

export class UpdateRestaurantStatusDTO {
    @IsEnum(RestaurantStatus)
    status!: RestaurantStatus;
}

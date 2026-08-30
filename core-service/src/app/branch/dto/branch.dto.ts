import {
    IsDateString,
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsString,
} from 'class-validator';

import { currencyEnum } from '../enums';

export class CreateBranchDto {
    @IsString()
    @IsNotEmpty()
    label!: string;

    @IsString()
    @IsNotEmpty()
    countryCode!: string;

    @IsString()
    @IsNotEmpty()
    addressText!: string;

    @IsNumber()
    @IsNotEmpty()
    lat!: number;

    @IsNumber()
    @IsNotEmpty()
    lng!: number;

    @IsDateString()
    @IsNotEmpty()
    opensAt!: string;

    @IsDateString()
    @IsNotEmpty()
    closeAt!: string;

    @IsNumber()
    @IsNotEmpty()
    deliveryRadius!: number;

    @IsEnum(currencyEnum)
    @IsNotEmpty()
    currency!: currencyEnum;
}
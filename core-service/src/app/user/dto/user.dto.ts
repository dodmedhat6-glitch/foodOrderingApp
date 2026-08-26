import {IsString , IsOptional} from 'class-validator'

export class UpdateUserDto{
    @IsOptional()
    @IsString()
    email?:string;

    @IsOptional()
    @IsString()
    phone?:string;

    @IsOptional()
    @IsString()
    name?:string;
}
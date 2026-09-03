import {IsArray, IsEmail, IsNotEmpty, IsOptional, IsString} from "class-validator";

export class CreateMemberDto{
    @IsEmail()
    @IsNotEmpty()
    email!: string;


    @IsString()
    @IsNotEmpty()
    name!:string;

    @IsString()
    @IsNotEmpty()
    phoneNumber!:string;

    @IsString()
    @IsNotEmpty()
    role!:string;


    @IsArray()
    @IsOptional()
    branchIds!:number[];
}
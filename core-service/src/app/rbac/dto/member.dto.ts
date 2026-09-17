import {IsArray, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString} from "class-validator";

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

export class UpdateMemberDto{
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    role!:string;

    @IsIn(["active", "inactive", "suspended"])
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    status!:string;
}


export class UpdateMemberBranchesDTO{
    @IsArray()
    branchIds!:number[];
}
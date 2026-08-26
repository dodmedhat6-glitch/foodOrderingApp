import {
    IsEmail, MinLength, IsString,
    IsStrongPassword, MaxLength, IsEnum, IsNotEmpty, Length
} from 'class-validator';

import { SystemRole } from '../../user/enums'

export class RegisterDto {
    @IsEmail()
    email!: string;

    @MinLength(10)
    @MaxLength(11)
    phone!: string;

    @MinLength(2)
    @IsString()
    name!: string;

    @IsStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1
    },
        { message: 'password is not strong enough' }
    )
    password!: string;

    @IsEnum(SystemRole)
    role!: SystemRole;

}


export class LoginDto {
    @IsEmail()
    email!: string;

    @IsString()
    @IsNotEmpty()
    password!: string;
}

export class PasswordForgetDto {
    @IsEmail()
    email!: string;
}

export class ResetPasswordDto {
    @IsEmail()
    email!: string;

    @IsString()
    @Length(6)
    otp!: string;

    @IsStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1
    },
        { message: 'password is not strong enough' }
    )
    newPassword!: string;
}
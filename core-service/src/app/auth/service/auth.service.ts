import { RegisterDto, LoginDto, PasswordForgetDto, ResetPasswordDto } from '../dto/auth.dto.js';

import {
    findUserByEmail, IsUserExistsByEmailOrPhone,
    insertUser, updateUserPassword
} from '../../user/repository/user.repo.js';

import {
    UserAlreadyExistsError, CannotSignupAsAdmin
    , IncorrectCredentials, InvalidOTP
} from '../error.js'

import {
    HashPassword, creatAccessToken, creatRefreshToken, verifyRefreshToken
    , comparePassword, generateOTP, hashOTP
} from '../utils.js'
import {
    createResetPassword,
    findLatestPasswordResetByUserId,
    updatePasswordResetConsumedAt
} from '../repo/reset_password.repo.js'
import { SystemRole } from '../../user/enums.js'
import { NotAuthenticated } from '../../../common/auth/error.js';


export class AuthService {

    register = async (data: RegisterDto) => {
        if (data.role == SystemRole.SYSTEM_ADMIN) {
            throw CannotSignupAsAdmin
        }

        //1.check if user already exists
        const existing = await IsUserExistsByEmailOrPhone(data.email, data.phone);

        //2.if exists, throw error
        if (existing) {
            throw UserAlreadyExistsError
        }

        //3.if not exists, hash the password
        const hashedPassword = await HashPassword(data.password)

        //4.create a new user in the database
        const now = new Date()
        const user = await insertUser({
            email: data.email,
            phone: data.phone,
            name: data.name,
            passwordHash: hashedPassword,
            systemRole: data.role,
            createdAt: now,
            updatedAt: now
        })


        //5.create a JWT token for the user, access and refresh token
        const payload = { user_id: user.id, role: data.role, email: user.email };
        const accessToken = creatAccessToken(payload);
        const refreshToken = creatRefreshToken(payload);

        //6.return the token and user data
        return {
            message: "user registered successful",
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
                SystemRole: user.systemRole
            }
        }
    }


    login = async (data: LoginDto) => {
        // find user by email input
        const user = await findUserByEmail(data.email)
        if (!user) {
            throw IncorrectCredentials
        }
        // compare password
        const matchPassword = await comparePassword(data.password, user.passwordHash)
        // if password does not match throw err
        if (!matchPassword) {
            throw IncorrectCredentials
        }
        // generate token
        const payload = { user_id: user.id, role: user.systemRole, email: user.email };
        const accessToken = creatAccessToken(payload);
        const refreshToken = creatRefreshToken(payload);

        return {
            message: "user login successful",
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
                SystemRole: user.systemRole
            }
        }
    }


    forgetPassword = async (data: PasswordForgetDto) => {
        //check if exists
        const user = await findUserByEmail(data.email);
        if (!user) {
            return
        }
        //generate an otp
        const otp = generateOTP()

        //hash otp 
        const hashedOTP = hashOTP(otp)

        // insert the otp 
        await createResetPassword({
            userId: user.id,
            otpHash: hashedOTP,
            expiresAt: new Date(Date.now() + (10 * 60 * 1000)),//10 min
            createdAt: new Date()
        })
        // TODO : SEND EMAIL
        console.log(otp);
    }

    resetPassword = async (data: ResetPasswordDto) => {
        //find user
        const user = await findUserByEmail(data.email);
        if (!user) {
            throw InvalidOTP
        }
        //find resetPassword
        const reset = await findLatestPasswordResetByUserId(user.id);
        if (!reset) {
            throw InvalidOTP
        }
        //check otp
        const inputOTPHash = hashOTP(data.otp);
        if (inputOTPHash !== reset.otpHash || reset.isExpired()) {
            throw InvalidOTP
        }

        // update user Password
        const newHashedPassword = await HashPassword(data.newPassword);
        await updateUserPassword(user.id, newHashedPassword)

        // update reset password
        await updatePasswordResetConsumedAt(reset.id)


    }

    refreshToken = async (token: string) => {
        try {
            const payload = verifyRefreshToken(token);
            const accessToken = creatAccessToken(payload);
            const refreshToken = creatRefreshToken(payload);

            return {
                message: "token refreshed successfully",
                accessToken,
                refreshToken
            }
        } catch {
            throw NotAuthenticated
        }
    }

}

export const authService = new AuthService();

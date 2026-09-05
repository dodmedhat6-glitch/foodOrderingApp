import {LoginDto, PasswordForgetDto, RegisterDto, ResetPasswordDto} from '../dto/auth.dto.js';

import {
    findUserByEmail,
    insertUser,
    IsUserExistsByEmailOrPhone,
    updateUserPassword
} from '../../user/repository/user.repo.js';

import {
    CannotSignupAsAdmin,
    IncorrectCredentials,
    InvalidOTP,
    RestaurantDataRequiredError,
    UserAlreadyExistsError
} from '../error.js'

import {
    comparePassword,
    creatAccessToken,
    creatRefreshToken,
    generateOTP,
    hashOTP,
    HashPassword,
    verifyRefreshToken
} from '../utils.js'
import {
    createResetPassword,
    findLatestPasswordResetByUserId,
    updatePasswordResetConsumedAt
} from '../repo/reset_password.repo.js'
import {SystemRole} from '../../user/enums.js'
import {NotAuthenticated} from '../../../common/auth/error.js';
import {restaurantService, RestaurantService} from "../../restaurant/service/restaurant.service";
import {db} from "../../../common/knex/kenx";
import {minutes} from "../../../common/times";
import {activateMemberByUserId} from "../../rbac/repository/restaurant_member.repo";


export class AuthService {
    constructor(private readonly restaurantService:RestaurantService ) {
    }

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
        const trx = await db.transaction();
        let user
        let restaurant
        try {
             user = await insertUser({
                email: data.email,
                phone: data.phone,
                name: data.name,
                passwordHash: hashedPassword,
                systemRole: data.role,
                createdAt: now,
                updatedAt: now
            }, trx)
            //check if the type of user is restaurant , then call restaurant service to create a new restaurant

            if (data.role == SystemRole.RESTAURANT_USER){
                if(data.restaurant == undefined){
                    throw RestaurantDataRequiredError
                }
               restaurant= await this.restaurantService.create(user.id,data.restaurant,trx)
                }
            await trx.commit();
        }

        catch(error){
            await trx.rollback()
            throw error
        }

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
            },
            restaurant
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
            expiresAt: new Date(Date.now() + minutes(10)),//10 min
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

        return user.id


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

    acceptInvite = async (data: ResetPasswordDto) =>{

        // in this function we can use the same service we used in reset password service
        const user = await this.resetPassword(data)

        // the last thing we need to active user
        await activateMemberByUserId(user)
    }

}

export const authService = new AuthService(restaurantService);

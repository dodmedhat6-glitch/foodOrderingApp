import {injectable, inject} from "tsyringe";
import {tokens} from "../../../lib/di/tokens";
import {IEmailProvider} from "../../../pkg/email/email.interface";
import {db} from "../../../lib/knex/kenx";

import {activateMemberByUserId, findRestaurantMemberWithRole} from "../../rbac/repository/restaurant_member.repo";
import {MemberService} from "../../rbac/service/member.service";
import {RestaurantService} from "../../restaurant/service/restaurant.service";
import {SystemRole} from "../../user/enums";
import {UserService} from "../../user/service/user.service";


import {passwordResetEmail} from "../templates/password-reset";
import {
    CannotSignupAsAdmin,
    IncorrectCredentials,
    InvalidOTP,
    RestaurantDataRequiredError
} from "../error";
import {
    createResetPassword,
    findLatestPasswordResetByUserId,
    updatePasswordResetConsumedAt
} from "../repo/reset_password.repo";
import {
    HashPassword,
    creatAccessToken,
    creatRefreshToken,
    comparePassword,
    generateOTP,
    hashOTP,
    verifyRefreshToken, JwtPayload
} from "../utils";
import {LoginDto, PasswordForgetDto, RegisterDto, ResetPasswordDto} from "../dto/auth.dto";
import {findUserByEmail, updateUserPassword} from "../../user/repository/user.repo";
import {findBranchesByMemberId} from "../../rbac/repository/member_branch.repo";


@injectable()
export class AuthService {
    constructor(
        @inject(tokens.RestaurantService) private readonly restaurantService: RestaurantService,
        @inject(tokens.UserService) private readonly userService: UserService,
        @inject(tokens.MemberService) private readonly memberService: MemberService,
        @inject(tokens.EmailProvider) private readonly emailProvider: IEmailProvider,
    ) {}

    register = async(data: RegisterDto )=> {
        if (data.role == SystemRole.SYSTEM_ADMIN) {
            throw CannotSignupAsAdmin
        }

        const trx = await db.transaction();
        let user
        let restaurant
        let restaurantMemberInfo: {restaurantId?: number, restaurantRole?: string, branchIds?: number[]} = {};
        try {
            user = await this.userService.create({
                email: data.email,
                phone: data.phone,
                name: data.name,
                password: data.password,
                systemRole: data.role,
            }, trx)

            // check if the type of user is restaurant, then call restaurant service to create a new restaurant
            if (data.role == SystemRole.RESTAURANT_USER) {
                if (data.restaurant == undefined) {
                    throw RestaurantDataRequiredError;
                }
                restaurant = await this.restaurantService.create(user.id, data.restaurant, trx)
                // insert the owner member via member service
                await this.memberService.createOwnerMember(restaurant.id, user.id, trx);
                restaurantMemberInfo = {
                    restaurantId: restaurant.id,
                    restaurantRole: 'owner',
                    branchIds: [],
                };
            }

            await trx.commit();
        } catch (error) {
            await trx.rollback();
            throw error;
        }

        // create access token , refresh token
        const payload : JwtPayload = {user_id: user.id, role: data.role, email: user.email, ...restaurantMemberInfo};
        const accessToken = creatAccessToken(payload);
        const refreshToken = creatRefreshToken(payload);

        return {
            message: "successfully registered user",
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
                systemRole: user.systemRole,
                createdAt: user.createdAt,
            },
            restaurant
        }
    }

    login = async(data: LoginDto )=> {
        const user = await findUserByEmail(data.email);
        if(!user) {
            throw IncorrectCredentials
        }
        const match = await comparePassword(data.password,user.passwordHash)
        if(!match) {
            throw IncorrectCredentials
        }

        let restaurantMemberInfo = null
        if(user.systemRole == SystemRole.RESTAURANT_USER) {
            const memberData =  await findRestaurantMemberWithRole(user.id);
            const branchIds = await findBranchesByMemberId(memberData.member.id);
            if(memberData)  {
                restaurantMemberInfo = {
                    restaurantId: memberData.member.restaurantId,
                    restaurantRole: memberData.roleName,
                    branchIds
                }
            }
        }
        const payload : JwtPayload = {user_id: user.id, role: user.systemRole, email: user.email, ...restaurantMemberInfo};
        const accessToken = creatAccessToken(payload);
        const refreshToken = creatRefreshToken(payload);
        return {
            message: "Login successful",
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
                systemRole: user.systemRole,
                createdAt: user.createdAt,
            }
        }
    }

    forgetPassword = async(data: PasswordForgetDto )=> {
        const user = await findUserByEmail(data.email);
        if(!user) {
            return
        }
        const otp =  generateOTP();
        const hashedOtp = hashOTP(otp);
        await createResetPassword({
                userId: user.id,
                otpHash: hashedOtp,
                expiresAt: new Date(Date.now() + (10*60*1000)),
                createdAt: new Date(),
            }
        )
        const email = passwordResetEmail(otp);
        await this.emailProvider.sendEmail(data.email, email.subject, email.html);
    }

    resetPassword =  async(data: ResetPasswordDto ) => {
        const user = await findUserByEmail(data.email);
        if (!user) {
            throw InvalidOTP
        }
        const reset = await findLatestPasswordResetByUserId(user.id);
        if(!reset) {
            throw InvalidOTP
        }
        const inputOTPHash = hashOTP(data.otp)

        if(inputOTPHash != reset.otpHash || reset.isExpired() ) {
            throw InvalidOTP
        }
        const hashedPassword = await HashPassword(data.newPassword);
        await updateUserPassword(user.id, hashedPassword);
        await updatePasswordResetConsumedAt(reset.id)

        return user;
    }

    refresh = async(refreshToken: string) => {
        if (!refreshToken) {
            throw IncorrectCredentials;
        }
        const payload = verifyRefreshToken(refreshToken);
        const accessToken = creatAccessToken({
            user_id: payload.user_id,
            role: payload.role,
            email: payload.email,
            restaurantId: payload.restaurantId,
            restaurantRole: payload.restaurantRole,
            branchIds: payload.branchIds
        });
        return {accessToken};
    }

    acceptInvite = async(data: ResetPasswordDto )=> {
        const user = await this.resetPassword(data)
        // activate member
        await activateMemberByUserId(user.id)
    }
}
import {CannotCreateOwnerUserError, RoleNotFound} from "../errors";
import {findUserByEmail, insertUser} from "../../user/repository/user.repo";
import {UserAlreadyExistsError} from "../../auth/error";
import {findRoleByName} from "../repository/role.repo";
import {db} from "../../../common/knex/kenx";
import {CreateMemberDto} from "../dto/member.dto";
import {SystemRole} from "../../user/enums";
import {createRestaurantMember} from "../repository/restaurant_member.repo";
import {RestaurantMemberStatus} from "../enums";
import {setMemberBranch} from "../repository/member_branch.repo";
import {generateOTP, hashOTP} from "../../auth/utils";
import {createResetPassword} from "../../auth/repo/reset_password.repo";
import {minutes} from "../../../common/times";
import {MemberBranchEntity} from "../entity/member-branch.entity";


export  class MemberService{
    async createMember(restaurantId:number , data: CreateMemberDto) {
            // don't accept owner role creation
            if(data.role === 'owner'){
                throw CannotCreateOwnerUserError
            }
            // check if uer already exists
            const existingUser = await findUserByEmail(data.email)
            if (existingUser){
                throw UserAlreadyExistsError
            }
            //find roleId by role name
            const roleId = await findRoleByName(data.role);
            if(!roleId){
                throw RoleNotFound
            }
            //create user , number , assign branches
            const trx = await db.transaction()
            const now = new Date()
            try{
                const user = await insertUser({
                    email : data.email,
                    phone: data.phoneNumber,
                    name : data.name,
                    passwordHash: '',
                    systemRole: SystemRole.RESTAURANT_USER,
                    createdAt: now,
                    updatedAt: now

                }, trx)

                const member = await  createRestaurantMember({
                    restaurantId ,
                    userId : user.id,
                    roleId,
                    createdAt: now,
                    updatedAt: now,
                    status: RestaurantMemberStatus.INACTIVE
                }, trx)

                const rows= data.branchIds.map(branchId => new MemberBranchEntity({
                    branchId : branchId,
                    memberId: member.id,
                    createdAt: now
                }))

                await setMemberBranch(member.id , rows ,trx)
                //generate otp , create password reset record , and send email
                const otp = generateOTP()

                //hash otp
                const hashedOTP = hashOTP(otp)

                // insert the otp
                await createResetPassword({
                    userId: user.id,
                    otpHash: hashedOTP,
                    expiresAt: new Date(Date.now() + minutes(10)),//10 min
                    createdAt: new Date()
                }, trx)
                // TODO : SEND EMAIL
                console.log(otp);

                await trx.commit()
            }catch (err){
                await trx.rollback()
                return err
            }

    }

    //TODO : PUT RESTAURANT MEMBER BRANCHES SERVICE


}

export const memberService = new MemberService()






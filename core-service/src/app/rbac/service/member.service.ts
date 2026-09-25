import {
    CannotCreateOwnerUserError,
    CannotDeleteOwnerUser, InvalidBranchIdsError,
    MemberNotFound,
    RoleNotFound,
    RoleNotFoundError
} from "../errors";
import {findUserByEmail, insertUser} from "../../user/repository/user.repo";
import {UserAlreadyExistsError} from "../../auth/error";
import {findRoleByName} from "../repository/role.repo";
import {db} from "../../../lib/knex/kenx";
import {CreateMemberDto, UpdateMemberBranchesDTO, UpdateMemberDto} from "../dto/member.dto";
import {SystemRole} from "../../user/enums";
import {
    createRestaurantMember, deleteMember,
    findMembersByRestaurantId,
    findRestaurantMemberWithRole, updateMember
} from "../repository/restaurant_member.repo";
import {RestaurantMemberStatus} from "../enums";
import {countBranchesByIdsAndRestaurant, setMemberBranch} from "../repository/member_branch.repo";
import {generateOTP, hashOTP} from "../../auth/utils";
import {createResetPassword} from "../../auth/repo/reset_password.repo";
import {minutes} from "../../../pkg/utils/times";
import {MemberBranchEntity} from "../entity/member-branch.entity";
import {AppError} from "../../../lib/error/AppError";
import {getPermissionsDetailsByRoleName} from "../repository/permission.repo";
import {injectable} from "tsyringe";
import {RestaurantMemberEntity} from "../entity/restaurant-member.entity";
import {Knex} from "knex";

@injectable()
export  class MemberService{

    async createOwnerMember(restaurantId: number, userId: number, trx: Knex.Transaction): Promise<RestaurantMemberEntity> {
        const ownerRoleId = await findRoleByName('owner', trx);
        if (!ownerRoleId) throw RoleNotFoundError;
        const now = new Date();
        return createRestaurantMember({
            restaurantId,
            userId,
            roleId: ownerRoleId,
            status: RestaurantMemberStatus.ACTIVE,
            createdAt: now,
            updatedAt: now,
        }, trx);
    }

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

    async listMember(restaurantId : number) {
        const list = await findMembersByRestaurantId(restaurantId);
        return {data : list};
    }



    async updateMember(restaurantId: number, memberId: number, data: UpdateMemberDto) {
        // single query: member + role name
        const result = await findRestaurantMemberWithRole(memberId);
        if (!result || Number(result.member.restaurantId) !== Number(restaurantId)) {
            throw MemberNotFound;
        }

        const updateData: {roleId?: number, status?: string} = {};
        if (data.role) {
            const roleId = await findRoleByName(data.role);
            if (!roleId) throw RoleNotFoundError;
            updateData.roleId = roleId;
        }
        if (data.status) {
            updateData.status = data.status;
        }

        await updateMember(memberId, updateData);
        return {message: "Member updated successfully"};
    }


    async deleteMember(restaurantId: number, memberId: number) {
        // single query: member + role name (no N+1)
        const result = await findRestaurantMemberWithRole(memberId);
        if (!result || Number(result.member.restaurantId) !== Number(restaurantId)) {
            throw MemberNotFound;
        }
        if (result.roleName === 'owner') {
            throw CannotDeleteOwnerUser;
        }
        await deleteMember(memberId);
        return {message: "Member deleted successfully"};
    }

    async updateMemberBranches(restaurantId: number, memberId: number, data: UpdateMemberBranchesDTO) {
        // single query: member + role name (no N+1)
        const result = await findRestaurantMemberWithRole(memberId);
        if (!result || Number(result.member.restaurantId) !== Number(restaurantId)) {
            throw MemberNotFound;
        }
        if (result.roleName === 'owner') {
            throw new AppError('Cannot assign branches to owners, they have access to all branches', 400);
        }

        // validate branchIds belong to this restaurant (single COUNT query)
        await this.validateBranchOwnership(data.branchIds, restaurantId);

        const now = new Date();
        const rows = data.branchIds.map(branchId => new MemberBranchEntity({
            branchId,
            memberId: result.member.id,
            createdAt: now,
        }));
        await setMemberBranch(memberId, rows);

        return {
            message: "Member branch assignments updated successfully",
            branchIds: data.branchIds,
        };
    }
    async getRolePermissions(roleName: string) {
        const permissions = await getPermissionsDetailsByRoleName(roleName);
        return {role: roleName, permissions};
    }

    async validateBranchOwnership(branchIds: number[], restaurantId: number) {
        if (branchIds.length === 0) return;
        const count = await countBranchesByIdsAndRestaurant(branchIds, restaurantId);
        if (count !== branchIds.length) {
            throw InvalidBranchIdsError;
        }
    }

}




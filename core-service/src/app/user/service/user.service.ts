import { UserNotFound } from "../errors"
import { findUserById , updateUser } from "../repository/user.repo"
import {UpdateUserDto} from "../dto/user.dto";

export class UserService {

    findByUserId = async (userId: number) => {
        const user = await findUserById(userId);
        if (!user) {
            throw UserNotFound
        }

        return {
            id: user.id,
            email: user.email,
            name: user.name,
            phone: user.phone,
            role: user.systemRole
        }
    }

    updateUserFields = async (userId:number , data:UpdateUserDto ) => {
        const user = await findUserById(userId)
        if(!user){
            throw UserNotFound
        }
        await updateUser(userId,data)

}
}


export const userService = new UserService()
import {Knex} from "knex";
import {injectable} from "tsyringe";
import {SystemRole} from "../enums";
import {UserNotFound} from "../errors";
import {UserAlreadyExistsError} from "../../auth/error";
import {HashPassword} from "../../auth/utils";
import {findUserById, findUserByEmail, createUser as createUserRepo, updateUser} from "../repository/user.repo";
import {UpdateUserDto} from "../dto/user.dto";
import {User} from "../entity/user.entity";

export interface CreateUserData {
    email: string;
    phone: string;
    name: string;
    password: string;
    systemRole: SystemRole;
}


@injectable()
export class UserService {
    create = async (data: CreateUserData, trx?: Knex | Knex.Transaction): Promise<User> => {
        const existing = await findUserByEmail(data.email);
        if (existing) {
            throw UserAlreadyExistsError;
        }
        const hashedPassword = data.password ? await HashPassword(data.password) : '';
        const now = new Date();
        return createUserRepo({
            email: data.email,
            phone: data.phone,
            name: data.name,
            passwordHash: hashedPassword,
            systemRole: data.systemRole,
            createdAt: now,
            updatedAt: now,
        }, trx);
    }

    getByUserId = async (userId:number) => {
        const user = await findUserById(userId);
        if(!user) {
            throw UserNotFound
        }
        return {
            id: user.id,
            email: user.email,
            name: user.name,
            phone: user.phone,
            systemRole: user.systemRole,
        }
    }

    updateProfile = async (userId: number, data: UpdateUserDto) => {
        const user = await findUserById(userId);
        if (!user) {
            throw UserNotFound;
        }
        const updated = await updateUser(userId, data);
        return {
            id: updated.id,
            email: updated.email,
            name: updated.name,
            phone: updated.phone,
            systemRole: updated.systemRole,
        };
    }
}

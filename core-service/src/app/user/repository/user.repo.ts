import { db } from "../../../common/knex/kenx"
import { User } from "../entity/user.entity";
import {Knex} from "knex";


const USER_COLUMNS = [
    "id",
    "email",
    "phone",
    "name",
    "password_hash",
    "system_role",
    "created_at",
    "updated_at",
    "deleted_at",
];

export type UpdateUserFields = {
    name?: string;
    phone?: string;
    email?: string;
};


function toEntity(row: any): User {
    return new User({
        id: row.id,
        email: row.email,
        phone: row.phone,
        name: row.name,
        systemRole: row.system_role,
        passwordHash: row.password_hash,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at
    });
}

export async function findUserByEmail(email: string): Promise<User | null> {
    // Implement the logic to find a user by email in the database
    const row = await db("users").select(USER_COLUMNS
    ).where("email", email).whereNull("deleted_at"
    ).first();

    return row ? toEntity(row) : null;
}
export async function findUserById(id: number): Promise<User | null> {
    // Implement the logic to find a user by email in the database
    const row = await db("users").select(USER_COLUMNS
    ).where("id", id).first();

    return row ? toEntity(row) : null;
}


export async function IsUserExistsByEmailOrPhone(email: string, phone: string): Promise<boolean> {
    // Implement the logic to find a user by email or phone in the database
    const result = await db.raw(
        `SELECT EXISTS(SELECT 1 FROM users WHERE email = ? OR phone = ?) 
            AS user_exists`, [email, phone]);
    return result.rows[0]?.user_exists ?? false;
}


export async function insertUser(user: Partial<User> , conn: Knex = db): Promise<User> {
    // Implement the logic to insert a new user into the database
    const [row] = await conn("users").insert({
        email: user.email,
        phone: user.phone,
        name: user.name,
        system_role: user.systemRole,
        password_hash: user.passwordHash,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
        deleted_at: user.deletedAt
    }).returning(USER_COLUMNS);
    return toEntity(row);
}


export async function updateUserPassword(id: number, password: string) {
    await db("users").where("id", id).update({
        password_hash: password
    })
}

export async function updateUser(id : number , user: UpdateUserFields) {
    await db("users").where("id",id).update(user)
}



import { db } from "../../../common/knex/kenx"
import { PasswordReset } from "../entity/password_reset.entity"
import {Knex} from "knex";

const PASSWORD_RESET_COLUMNS = [
    "id",
    "user_id",
    "otp_code",
    "expires_at",
    "created_at",
    "consumed_at"
]

function toEntity(row: any): PasswordReset {
    return new PasswordReset({
        id: row.id,
        userId: row.user_id,
        otpHash: row.otp_code,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        consumedAt: row.consumed_at
    })
}


export async function createResetPassword(passwordReset: Partial<PasswordReset>, trx? : Knex) {
    const query = trx || db
    await query("password_reset").insert({
        user_id: passwordReset.userId,
        otp_code: passwordReset.otpHash,
        expires_at: passwordReset.expiresAt,
        created_at: passwordReset.createdAt
    })
}

export async function findLatestPasswordResetByUserId(userId: number): Promise<PasswordReset | undefined> {
    const row = await db("password_reset")
        .select(PASSWORD_RESET_COLUMNS)
        .where("user_id", userId)
        .whereNull('consumed_at')
        .orderBy('id', 'desc')
        .first();

    return row ? toEntity(row) : undefined;
}

export async function updatePasswordResetConsumedAt(id: number) {
    await db('password_reset').where('id', id).update({
        consumed_at: new Date(),
    })
}







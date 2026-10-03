import { db } from "../../../lib/knex/kenx";
import { ApiKeyEntity } from "../entity/api-key.entity";

function toEntity(row: any): ApiKeyEntity {
    return new ApiKeyEntity({
        id: row.id,
        name: row.name,
        keyHash: row.key_hash,
        roleId: row.role_id,
        roleName: row.role_name,
        status: row.status,
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    });
}

export async function findActiveApiKeyByHash(keyHash: string): Promise<ApiKeyEntity | undefined> {
    const row = await db("api_keys as ak")
        .select("ak.id", "ak.name", "ak.key_hash", "ak.role_id", "r.name as role_name",
            "ak.status", "ak.last_used_at", "ak.created_at", "ak.updated_at")
        .join("roles as r", "r.id", "ak.role_id")
        .where("ak.key_hash", keyHash)
        .where("ak.status", "active")
        .first();

    return row ? toEntity(row) : undefined;
}

export async function touchApiKeyLastUsed(id: number): Promise<void> {
    await db("api_keys").where("id", id).update({ last_used_at: new Date() });
}

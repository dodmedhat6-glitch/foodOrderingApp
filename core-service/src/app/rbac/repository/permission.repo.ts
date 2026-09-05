import {PermissionEntity} from "../entity/permission.entity";
import {Knex} from "knex";
import {db} from "../../../common/knex/kenx";

function toEntity(row: any): PermissionEntity{
    return new PermissionEntity({
        id : row.id,
        resource: row.resource ,
        action: row.action,
        createdAt: row.created_at
    })
}


export async function getPermissionByRoleName(roleName: string , trx? :Knex.Transaction): Promise<string[]>{
    const query = trx || db

    const row = await query("permissions as p")
        .select("p.id" , "p.resource" , "p.action", "p.created_at")
        .join("role_permission as rp" , "p.id" , "rp.permission_id")
        .join("roles as r" , "rp.role_id" , "r.id")
        .where("r.name" , roleName)

    return row.map(row =>{
        const entity = toEntity(row);
        return `${entity.resource}:${entity.action}`
    })

}
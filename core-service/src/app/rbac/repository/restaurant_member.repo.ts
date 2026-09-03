import {RestaurantMemberEntity} from "../entity/restaurant-member.entity";
import {Knex} from "knex";
import {db} from "../../../common/knex/kenx";
import {RestaurantMemberStatus} from "../enums";

const MEMBER_COLUMNS = ['id', 'restaurant_id', 'user_id', 'role_id', 'status', 'created_at', 'updated_at'];

function toEntity(row: any): RestaurantMemberEntity {
    return new RestaurantMemberEntity({
        id: row.id,
        restaurantId: row.restaurant_id,
        userId: row.user_id,
        roleId: row.role_id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    });
}

export async function createRestaurantMember(data: Partial<RestaurantMemberEntity> , conn: Knex = db): Promise<RestaurantMemberEntity>{
    const query = conn || db;
    const [row] = await query('restaurant_members').insert({
        restaurant_id: data.restaurantId,
        user_id: data.userId,
        role_id: data.roleId,
        status: data.status,
        created_at: data.createdAt,
        updated_at: data.updatedAt
    }).returning(MEMBER_COLUMNS)
    return toEntity(row)
}

export async function activateMemberByUserId(userId: number , conn: Knex = db): Promise<void> {
    const query = conn || db ;
    await query('restaurant_members').where('user_id' , userId).update({status: RestaurantMemberStatus.ACTIVE , updated_at : new Date()})
}


import {RestaurantEntity} from "../entity/restaurant.entity";
import {db} from "../../../common/knex/kenx";
import {Knex} from "knex";

const RESTAURANT_COLUMNS = [
    'id' ,
    'owner_id',
    'name',
    'logo_url',
    'status',
    'primary_country',
    'create_at',
    'updated_at',
    'status_updated_at'
];


function toEntity(row:any){
    return new RestaurantEntity({
        id : row.id,
        ownerId : row.owner_id,
        name : row.name,
        logoURL: row.logo_url,
        status: row.status,
        primaryCountry: row.primary_country,
        createdAt: row.create_at,
        updateAt: row.updated_at,
        statusUpdatedAt: row.status_updated_at
    })
}


export async function findAllRestaurants(): Promise<RestaurantEntity[]>{
    const row = await db('restaurants').select(RESTAURANT_COLUMNS)
    return row.map(toEntity)
}

// TODO: find restaurant by id
export async function findRestaurantById(id:number): Promise<RestaurantEntity>{
    const row = await db('restaurants').select(RESTAURANT_COLUMNS).where("id",id).first();
    return toEntity(row)
}


export async function createRestaurant(data : Partial<RestaurantEntity> , conn : Knex = db ): Promise<RestaurantEntity>{
    const [row] = await conn('restaurants').insert({
        owner_id: data.ownerId,
        name: data.name,
        logo_url: data.logoURL,
        status: data.status,
        primary_country: data.primaryCountry,
        create_at: data.createdAt,
        updated_at: data.updateAt,
        status_updated_at: data.statusUpdatedAt
    }).returning(RESTAURANT_COLUMNS);
    return toEntity(row);


}











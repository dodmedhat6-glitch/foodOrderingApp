import {RestaurantEntity} from "../entity/restaurant.entity";
import {db} from "../../../lib/knex/kenx";
import {Knex} from "knex";
import {
    applyCursorPagination,
    applyFilters,
    FilterParams,
    PaginationParams
} from "../../../lib/http/pagination/cursor.pagination";

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

const RESTAURANT_SORT_COLUMNS: Record<string, string> = {
    id: 'id',
    ownerId: 'owner_id',
    name: 'name',
    logoURL: 'logo_url',
    status: 'status',
    primaryCountry: 'primary_country',
    createdAt: 'create_at',
    updateAt: 'updated_at',
    statusUpdatedAt: 'status_updated_at'
};


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


export async function findAllRestaurants(params : PaginationParams , filters : FilterParams[]): Promise<RestaurantEntity[]>{
    const sortBy = RESTAURANT_SORT_COLUMNS[params.sortBy] ?? 'id';
    const paginationParams = {...params, sortBy};
    let query = db('restaurants').select(RESTAURANT_COLUMNS)
    query = applyFilters(query, filters)
    query = applyCursorPagination(query, paginationParams)
    const row = await query;
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

export async function updateRestaurant(id: number, data: {name?: string, logoUrl?: string, primaryCountry?: string}): Promise<RestaurantEntity> {
    const [row] = await db("restaurants").where("id", id).update({
        name: data.name,
        logo_url: data.logoUrl,
        primary_country: data.primaryCountry,
        updated_at: new Date(),
    }).returning(RESTAURANT_COLUMNS);
    return toEntity(row);
}

export async function updateRestaurantStatus(id: number, status: string): Promise<RestaurantEntity> {
    const now = new Date();
    const [row] = await db("restaurants").where("id", id).update({
        status,
        status_updated_at: now,
        updated_at: now,
    }).returning(RESTAURANT_COLUMNS);
    return toEntity(row);
}








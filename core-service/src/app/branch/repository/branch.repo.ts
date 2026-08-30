import {BranchEntity} from "../entity/branch.entity";
import {Knex}from "knex";
import {db} from "../../../common/knex/kenx";

const BRANCHES_COLUMNS = [
    "id",
    "restaurant_id",
    "country_code",
    "address_text",
    "label",
    "lat",
    "lng",
    "is_active",
    "opens_at",
    "closes_at",
    "accept_orders",
    "created_at",
    "updated_at",
    "delivery_radius",
    "currency",
    "commission"
];

function toEntity(row: any): BranchEntity {
    return new BranchEntity({
        id: Number(row.id),
        restaurantId: Number(row.restaurant_id),
        countryCode: row.conutry_code,
        addressText: row.address_text,
        label: row.label,
        lat: parseFloat(row.lat),
        lng: parseFloat(row.lng),
        isActive: row.is_active,
        opensAt: row.opens_at,
        closesAt: row.closes_at,
        acceptOrders: row.accept_orders,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deliveryRadius: Number(row.dilevry_radius),
        currency: row.currency,
        commission: Number(row.commission)
    });
}


export async function createBranch(data : Partial<BranchEntity> , conn : Knex = db): Promise<BranchEntity>{
    const [row] = await conn('restaurant_branches').insert({
        restaurant_id: data.restaurantId,
        country_code: data.countryCode,
        address_text: data.addressText,
        label: data.label,
        lat: data.lat,
        lng: data.lng,
        is_active: data.isActive ?? false,
        opens_at: data.opensAt,
        closes_at: data.closesAt,
        accept_orders: data.acceptOrders ?? false,
        created_at: data.createdAt ?? new Date(),
        updated_at: data.updatedAt ?? new Date(),
        delivery_radius: data.deliveryRadius,
        currency: data.currency,
        commission: data.commission ?? 0
    }).returning(BRANCHES_COLUMNS);

    return toEntity(row);
}


export async function findNearbyBranches(lat: number , lng:number ): Promise<BranchEntity[]>{
    const result = await db.raw(`
        SELECT 
        b.id,
        b.retaurant_id,
        b.address_text,
        b.label,
        b.lat,
        b.lng,
        b.is_active,
        b.accept_orders,
        b.currency,
        r.name,
        r.logo_url
        FROM restaurant_branches b JOIN restaurant r ON b.restaurant_id = r.id
        WHERE b.is_active = true AND r.status='active'
        AND ST_DWithin(b.location , ST_MakePoint(?,?)::geography, b.delivery_radius*1000)   
    `,[lng , lat])
    return result.rows;
}


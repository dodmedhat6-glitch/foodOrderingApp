import {Knex} from "knex";
import {db} from "../../../lib/knex/kenx";
import {Branch} from "../entity/branch.entity";

const BRANCH_COLUMNS = ['id','restaurant_id','country_code','address_text','label','lat','lng',
    'is_active','opens_at','closes_at','accept_orders','created_at','updated_at',
    'delivery_radius','currency','commission','delivery_fee_minor','location'];

/**
 * node-postgres hands back `bigint` columns as strings (it won't silently
 * narrow a 64-bit value into a JS number), but every id and money field below
 * is declared `number` on the entity - and order-service's checkout adds
 * delivery_fee_minor to a subtotal, where a string would concatenate instead
 * of summing. Coerce at this boundary so nothing downstream has to know.
 */
function toEntity(row: any) {
    return new Branch({
        id: Number(row.id),
        restaurantId: Number(row.restaurant_id),
        countryCode: row.country_code,
        addressText: row.address_text,
        label: row.label,
        lat: Number(row.lat),
        lng: Number(row.lng),
        isActive: row.is_active,
        opensAt: row.opens_at,
        closesAt: row.closes_at,
        acceptOrders: row.accept_orders,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deliveryRadius: row.delivery_radius,
        currency: row.currency,
        commission: Number(row.commission),
        deliveryFeeMinor: Number(row.delivery_fee_minor),
        location: row.location
    });
}

export async function createBranch (data: Partial <Branch>, conn: Knex = db): Promise<Branch> {
    const [row] = await conn("restaurant_branches").insert({
        restaurant_id: data.restaurantId,
        country_code: data.countryCode,
        address_text: data.addressText,
        label: data.label,
        lat: data.lat,
        lng: data.lng,
        is_active: data.isActive,
        opens_at: data.opensAt,
        closes_at: data.closesAt,
        accept_orders: data.acceptOrders,
        created_at: data.createdAt,
        updated_at: data.updatedAt,
        delivery_radius: data.deliveryRadius,
        currency: data.currency,
        commission: data.commission,
        delivery_fee_minor: data.deliveryFeeMinor ?? 0
    }).returning(BRANCH_COLUMNS);

    return toEntity(row);
}

export async function findBranchesByRestaurant(restaurantId: number): Promise<Branch[]> {
    const rows = await db("restaurant_branches").select(BRANCH_COLUMNS).where("restaurant_id", restaurantId);
    return rows.map(toEntity);
}

export async function findBranchById(id: number): Promise<Branch | undefined> {
    const row = await db("restaurant_branches").select(BRANCH_COLUMNS).where("id", id).first();
    return row ? toEntity(row) : undefined;
}

export async function updateBranch(id: number, data: Record<string, any>, conn: Knex = db): Promise<Branch> {
    const [row] = await conn("restaurant_branches").where("id", id).update({
        label: data.label,
        address_text: data.addressText,
        lat: data.lat,
        lng: data.lng,
        opens_at: data.opensAt,
        closes_at: data.closesAt,
        delivery_radius: data.deliveryRadius,
        currency: data.currency,
        accept_orders: data.acceptOrders,
        delivery_fee_minor: data.deliveryFeeMinor,
        updated_at: new Date(),
    }).returning(BRANCH_COLUMNS);
    return toEntity(row);
}

export async function updateBranchStatus(id: number, data: {isActive?: boolean, commission?: number}, conn: Knex = db): Promise<Branch> {
    const [row] = await conn("restaurant_branches").where("id", id).update({
        is_active: data.isActive,
        commission: data.commission,
        updated_at: new Date(),
    }).returning(BRANCH_COLUMNS);
    return toEntity(row);
}

export async function findNearbyBranches(lat: number, lng: number): Promise<Branch[]> {
    const result = await db.raw(`
       SELECT 
       b.id,
       b.restaurant_id,
       b.address_text,
       b.label,
       b.lat,
       b.lng,
       b.is_active,
       b.accept_orders,
       b.currency,
       r.name,
       r.logo_url
       FROM restaurant_branches b JOIN restaurants r ON  b.restaurant_id = r.id
       WHERE b.is_active = true AND r.status ='active'
       AND ST_DWithin(b.location, ST_MakePoint(?, ?)::geography, b.delivery_radius*1000)
    `,[lng, lat]);

    return result.rows.map(toEntity);
}
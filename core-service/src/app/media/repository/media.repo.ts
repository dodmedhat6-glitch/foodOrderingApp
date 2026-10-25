import {Knex} from "knex";
import {db} from "../../../lib/knex/kenx";
import {MediaEntity} from "../entity/media.entity";
import {MediaStatus} from "../enums";
import {
    applyCursorPagination,
    applyFilters,
    FilterParams,
    PaginationParams
} from "../../../lib/http/pagination/cursor.pagination";

const MEDIA_COLUMNS = [
    'id',
    'restaurant_id',
    'uploaded_by',
    'status',
    'media_path',
    'content_type',
    'size_bytes',
    'created_at'
];

const MEDIA_SORT_COLUMNS: Record<string, string> = {
    id: 'id',
    restaurantId: 'restaurant_id',
    uploadedBy: 'uploaded_by',
    status: 'status',
    mediaPath: 'media_path',
    contentType: 'content_type',
    sizeBytes: 'size_bytes',
    createdAt: 'created_at'
};

function toEntity(row: any): MediaEntity {
    return new MediaEntity({
        id: row.id,
        restaurantId: row.restaurant_id,
        uploadedBy: row.uploaded_by,
        status: row.status,
        mediaPath: row.media_path,
        contentType: row.content_type,
        sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? 0 : Number(row.size_bytes),
        createdAt: row.created_at
    });
}

export async function createMedia(data: Partial<MediaEntity>, conn: Knex = db): Promise<MediaEntity> {
    const [row] = await conn('media').insert({
        restaurant_id: data.restaurantId,
        uploaded_by: data.uploadedBy,
        status: data.status,
        media_path: data.mediaPath,
        content_type: data.contentType,
        size_bytes: data.sizeBytes,
        created_at: data.createdAt ?? new Date()
    }).returning(MEDIA_COLUMNS);
    return toEntity(row);
}

export async function findMediaById(id: number): Promise<MediaEntity | undefined> {
    const row = await db('media').select(MEDIA_COLUMNS).where('id', id).first();
    return row ? toEntity(row) : undefined;
}

export async function findMediaByRestaurant(
    restaurantId: number,
    params: PaginationParams,
    filters: FilterParams[]
): Promise<MediaEntity[]> {
    const sortBy = MEDIA_SORT_COLUMNS[params.sortBy] ?? 'id';
    let query = db('media').select(MEDIA_COLUMNS).where('restaurant_id', restaurantId);
    query = applyFilters(query, filters);
    query = applyCursorPagination(query, {...params, sortBy});
    const rows = await query;
    return rows.map(toEntity);
}

export async function updateMediaStatus(
    id: number,
    status: MediaStatus,
    conn: Knex = db
): Promise<MediaEntity | undefined> {
    const [row] = await conn('media').where('id', id).update({status}).returning(MEDIA_COLUMNS);
    return row ? toEntity(row) : undefined;
}

export async function updateMediaUpload(
    id: number,
    data: {status: MediaStatus, contentType?: string, sizeBytes?: number},
    conn: Knex = db
): Promise<MediaEntity | undefined> {
    const patch: Record<string, unknown> = {status: data.status};
    if (data.contentType !== undefined) patch.content_type = data.contentType;
    if (data.sizeBytes !== undefined) patch.size_bytes = data.sizeBytes;

    const [row] = await conn('media').where('id', id).update(patch).returning(MEDIA_COLUMNS);
    return row ? toEntity(row) : undefined;
}

import {Knex} from "knex";

export interface PaginationParams {
    cursor?: string;
    limit: number;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
}

export interface FilterParams{
    field: string;
    operator: 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'like';
    value: string | string[];
}

export interface PaginationMeta {
    nextCursor: string | null;
    hasMore: boolean;
    count: number;
}

/* we need to implement a query builder that
 takes in the paginationParams and filterParams
 and returns a query string */



export function applyCursorPagination(query: Knex.QueryBuilder, params: PaginationParams): Knex.QueryBuilder {
    if (!params.sortBy || !params.sortOrder || !Number.isFinite(params.limit) || params.limit <= 0) {
        return query;
    }

    if (params.cursor) {
        const op = params.sortOrder === 'asc' ? '>' : '<';
        query = query.where(params.sortBy, op, params.cursor); // if sortBy = 'id' , op = '>' , cursor = '5' => knex will build a query like "WHERE id > 5"
    }
    return query.orderBy(params.sortBy, params.sortOrder).limit(params.limit + 1);
}


export function applyFilters(query: Knex.QueryBuilder, filters: FilterParams[]): Knex.QueryBuilder {
    for (const filter of filters) {
        switch (filter.operator) {
            case 'eq':
                query = query.where(filter.field, filter.value);break;
            case 'gt':
                query = query.where(filter.field, '>', filter.value);break;
            case 'lt':
                query = query.where(filter.field, '<', filter.value);break;
            case 'gte':
                query = query.where(filter.field, '>=', filter.value);break;
            case 'lte':
                query = query.where(filter.field, '<=', filter.value);break;
            case 'in':
                query = query.whereIn(filter.field, Array.isArray(filter.value) ? filter.value : [filter.value]);break;
            case 'like':
                query = query.whereLike(filter.field, `%${filter.value}%`);break;
        }
    }
    return query;
}


export function buildPaginationResult<T>(rows: T[], limit:number, sortBy : string): {data: T[], meta: PaginationMeta} {

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    let nextCursor: string | null = null;
    if (data.length > 0) {
        const lastItem = data[data.length - 1] as any ;
        nextCursor = hasMore && lastItem? String(lastItem[sortBy]) : null;
    }
    return {
        data,
        meta: {
            nextCursor: nextCursor,
            hasMore,
            count: data.length
        }
    }
}


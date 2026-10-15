import {Knex} from "knex";

export interface PaginationParams {
    cursor?: string;
    limit: number;
    sortBy: string;
    sortOrder: "asc" | "desc";
}

export interface FilterParams {
    field: string;
    operator: "eq" | "gt" | "lt" | "lte" | "gte" | "in" | "like";
    value: string | string[];
}

export interface PaginationMeta {
    nextCursor: string | null;
    hasMore: boolean;
    count: number;
}

function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function applyCursorPagination(
    query: Knex.QueryBuilder,
    params: PaginationParams,
): Knex.QueryBuilder {
    if (!params.sortBy) return query;
    const dbColumn = camelToSnake(params.sortBy);
    if (params.cursor) {
        const op = params.sortOrder === "asc" ? ">" : "<";
        query = query.where(dbColumn, op, params.cursor);
    }
    return query.orderBy(dbColumn, params.sortOrder).limit(params.limit + 1);
}

export function applyFilters(
    query: Knex.QueryBuilder,
    filters: FilterParams[],
): Knex.QueryBuilder {
    for (const filter of filters) {
        switch (filter.operator) {
            case "eq":
                query.where(filter.field, filter.value);
                break;
            case "gt":
                query.where(filter.field, ">", filter.value);
                break;
            case "lt":
                query.where(filter.field, "<", filter.value);
                break;
            case "lte":
                query.where(filter.field, "<=", filter.value);
                break;
            case "gte":
                query.where(filter.field, ">=", filter.value);
                break;
            case "like":
                query.whereLike(filter.field, `%${filter.value}%`);
                break;
            case "in":
                query.whereIn(
                    filter.field,
                    Array.isArray(filter.value) ? filter.value : [filter.value],
                );
                break;
        }
    }
    return query;
}

export function buildPaginationResult<T>(
    rows: T[],
    limit: number,
    sortBy: string,
): {data: T[]; meta: PaginationMeta} {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor: string | null = null;

    if (data.length > 0) {
        const lastItem = data[data.length - 1] as Record<string, unknown>;
        nextCursor = hasMore && lastItem ? String(lastItem[sortBy]) : null;
    }
    return {
        data,
        meta: {nextCursor, hasMore, count: data.length},
    };
}

/**
 * Builds a cursor page where the caller, not this helper, decides how to
 * serialize the cursor.
 *
 * `buildPaginationResult` stringifies the sort field with `String(value)`,
 * which is wrong for a Date: `String(date)` yields "Fri Oct 02 2026 ..." and
 * Postgres can't round-trip that back into a timestamp comparison. Date-sorted
 * endpoints pass `(row) => String(row.createdAt.getTime())` here and convert
 * the cursor back with `new Date(Number(cursor))`, which keeps the value a
 * Date object end to end — the only form node-postgres converts to a
 * `timestamp without time zone` consistently.
 */
export function buildPaginationResultBy<T>(
    rows: T[],
    limit: number,
    toCursor: (row: T) => string,
): {data: T[]; meta: PaginationMeta} {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = data[data.length - 1];

    return {
        data,
        meta: {
            nextCursor: hasMore && last ? toCursor(last) : null,
            hasMore,
            count: data.length,
        },
    };
}

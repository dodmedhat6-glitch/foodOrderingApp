import {FilterParams, PaginationParams} from "./cursor.pagination";

export function parseQuery(query: Record<string, any>): PaginationParams {
    const parsedLimit = Number(query.limit);
    return {
        cursor: query.cursor as string | undefined,
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(1000, Math.floor(parsedLimit)) : 20,
        sortBy: query.sortBy as string || 'id',
        sortOrder: String(query.sortOrder).toLowerCase() === 'desc' ? 'desc' : 'asc'
    };
}

export function parseFilters(query: Record<string, any>, allowedFields: string[]): FilterParams[] {
    const filter = query.filter;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return [];

    const allowedOps = ['eq', 'gt', 'lt', 'gte', 'lte', 'in', 'like'];

    return allowedFields.flatMap((field) => {
        const fieldFilters = filter[field];
        if (!fieldFilters || typeof fieldFilters !== 'object' || Array.isArray(fieldFilters)) return [];

        return Object.entries(fieldFilters)
            .filter(([operator]) => allowedOps.includes(operator))
            .map(([operator, value]) => ({
                field,
                operator: operator as FilterParams['operator'],
                value: Array.isArray(value) ? value.map((item) => String(item)) : String(value)
            }));
    });
}
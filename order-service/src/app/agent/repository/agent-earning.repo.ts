import {Knex} from "knex";
import {AgentEarningEntity} from "../entity/agent-earning.entity";
import {CreateAgentEarningInput, EarningsRange, EarningsTotals} from "../types";
import {PaginationParams} from "../../../lib/http/pagination/cursor-pagination";

const AGENT_EARNING_COLUMNS = [
    "id",
    "region",
    "agent_id",
    "order_id",
    "order_public_id",
    "amount",
    "currency",
    "distance_meters",
    "earned_at",
];

function toEntity(row: any): AgentEarningEntity {
    return new AgentEarningEntity({
        id: Number(row.id),
        region: row.region,
        agentId: Number(row.agent_id),
        orderId: Number(row.order_id),
        orderPublicId: row.order_public_id,
        amount: row.amount,
        currency: row.currency,
        distanceMeters: row.distance_meters === null ? null : Number(row.distance_meters),
        earnedAt: row.earned_at,
    });
}

/**
 * Insert that yields to `uq_agent_earnings_order_id` rather than erroring on
 * it, returning `undefined` when the earning was already recorded.
 *
 * `ON CONFLICT DO NOTHING` and not a try/catch, for the same reason
 * `createTransactionIfNew` is written this way: this runs inside the
 * settlement transaction, and in Postgres a constraint violation aborts the
 * whole transaction — so "insert and catch the duplicate" would poison every
 * statement after it. Yielding in SQL keeps the transaction usable and keeps
 * the *constraint*, not application logic, as the thing preventing a second
 * payout for one delivery.
 */
export async function createEarningIfNew(
    data: CreateAgentEarningInput,
    conn: Knex,
): Promise<AgentEarningEntity | undefined> {
    const [row] = await conn("agent_earnings")
        .insert({
            region: data.region,
            agent_id: data.agentId,
            order_id: data.orderId,
            order_public_id: data.orderPublicId,
            amount: data.amount,
            currency: data.currency,
            distance_meters: data.distanceMeters,
            earned_at: new Date(),
        })
        .onConflict("order_id")
        .ignore()
        .returning(AGENT_EARNING_COLUMNS);

    return row ? toEntity(row) : undefined;
}

/**
 * One page of an agent's earnings — backed by
 * idx_agent_earnings_agent_earned_at, which is why agent_id is the equality
 * predicate and earned_at the range column.
 *
 * Returns limit + 1 rows so the caller can tell whether another page exists,
 * matching `findOrdersByCustomer`.
 */
export async function findEarningsByAgent(
    agentId: number,
    range: EarningsRange,
    params: PaginationParams,
    conn: Knex,
): Promise<AgentEarningEntity[]> {
    const query = conn("agent_earnings")
        .select(AGENT_EARNING_COLUMNS)
        .where("agent_id", agentId)
        .where("earned_at", ">=", range.from)
        .where("earned_at", "<", range.to);

    if (params.cursor) {
        const millis = Number(params.cursor);
        if (Number.isFinite(millis)) {
            query.where("earned_at", params.sortOrder === "asc" ? ">" : "<", new Date(millis));
        }
    }

    const rows = await query.orderBy("earned_at", params.sortOrder).limit(params.limit + 1);
    return rows.map(toEntity);
}

/**
 * Totals for the whole range, not just the page.
 *
 * Deliberately a second query rather than a sum over the rows already
 * fetched: the page is 20 rows and the month is hundreds, so summing the page
 * would report a number that silently changes as the agent scrolls. Same
 * index serves both.
 *
 * `MIN(currency)` is a single-region read standing in for "the currency these
 * earnings are in" — one shard is one country is one currency. It is written
 * as an aggregate because Postgres requires one, not because a restaurant
 * could pay in two.
 */
export async function sumEarningsByAgent(
    agentId: number,
    range: EarningsRange,
    conn: Knex,
): Promise<EarningsTotals> {
    const row = await conn("agent_earnings")
        .where("agent_id", agentId)
        .where("earned_at", ">=", range.from)
        .where("earned_at", "<", range.to)
        .select(
            conn.raw("COUNT(*)::int AS count"),
            conn.raw("COALESCE(SUM(amount), 0)::int AS sum"),
            conn.raw("MIN(currency) AS currency"),
        )
        .first<{count: number; sum: number; currency: string | null}>();

    return {
        count: row?.count ?? 0,
        sum: row?.sum ?? 0,
        currency: row?.currency ?? null,
    };
}

/** The earning recorded for one order, if settlement has already run. */
export async function findEarningByOrderId(
    orderId: number,
    conn: Knex,
): Promise<AgentEarningEntity | undefined> {
    const row = await conn("agent_earnings")
        .select(AGENT_EARNING_COLUMNS)
        .where("order_id", orderId)
        .first();

    return row ? toEntity(row) : undefined;
}

import {OrderStatus} from "../order/enums";

/**
 * Module-level helper shapes shared between the repo, services and controller,
 * so none of those files declares an inline interface (CLAUDE.md s5.10).
 */

/** Everything the repo needs to insert one `agent_earnings` row. */
export interface CreateAgentEarningInput {
    region: string;
    agentId: number;
    orderId: number;
    orderPublicId: string;
    amount: number;
    currency: string;
    distanceMeters: number | null;
}

/** The half-open range an earnings read covers. */
export interface EarningsRange {
    from: Date;
    to: Date;
}

/** `SUM`/`COUNT` over a range, as the repo returns it. */
export interface EarningsTotals {
    count: number;
    sum: number;
    /**
     * Null when the range is empty — there is no currency to report for no
     * rows, and inventing one would be a guess about a restaurant the agent
     * may not have delivered for.
     */
    currency: string | null;
}

/** Filters on `GET /api/agents/tasks`. */
export interface AgentTaskFilters {
    status?: OrderStatus;
    from: Date;
    to: Date;
}

/** The authenticated agent, as the controller resolves them from the JWT. */
export interface AgentRequester {
    agentId: number;
    region: string;
}

/**
 * What presence stores about an agent's current job.
 *
 * Serialized into the single opaque `activity` string the presence port
 * accepts — `pkg/presence` deliberately knows nothing about orders, so the
 * encoding lives here, next to the only code that reads it.
 */
export interface ActiveOrderRef {
    orderId: number;
    orderPublicId: string;
    customerId: number;
}

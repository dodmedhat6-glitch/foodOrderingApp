import {AgentEarningEntity} from "../entity/agent-earning.entity";
import {EarningsRange, EarningsTotals} from "../types";

/**
 * Wire shapes for the agent's own reads (CLAUDE.md s6). Money is integer minor
 * units next to a currency; timestamps are ISO-8601 UTC. The internal
 * bigserial ids and the region never cross this boundary.
 */

/** WebSocket events the agent module publishes. */
export enum AgentWsEvent {
    /** The agent's live position, forwarded to the customer they are serving. */
    POSITION = "delivery.position",
}

export class AgentEarningResponseDTO {
    orderPublicId!: string;
    amount!: number;
    currency!: string;
    distanceMeters?: number;
    earnedAt!: string;

    static from(earning: AgentEarningEntity): AgentEarningResponseDTO {
        const dto = new AgentEarningResponseDTO();
        dto.orderPublicId = earning.orderPublicId;
        dto.amount = earning.amount;
        dto.currency = earning.currency;
        if (earning.distanceMeters !== null) dto.distanceMeters = earning.distanceMeters;
        dto.earnedAt = earning.earnedAt.toISOString();
        return dto;
    }
}

export class AgentEarningsResponseDTO {
    range!: {from: string; to: string};
    /**
     * Covers the **whole range**, not the page. An agent checking what they
     * made this month wants the month, and a total that shrank as they
     * scrolled would be worse than no total at all.
     */
    totals!: {count: number; sum: number; currency: string | null};
    items!: AgentEarningResponseDTO[];
    nextCursor!: string | null;

    static from(
        range: EarningsRange,
        totals: EarningsTotals,
        items: AgentEarningEntity[],
        nextCursor: string | null,
    ): AgentEarningsResponseDTO {
        const dto = new AgentEarningsResponseDTO();
        dto.range = {from: range.from.toISOString(), to: range.to.toISOString()};
        dto.totals = totals;
        dto.items = items.map(AgentEarningResponseDTO.from);
        dto.nextCursor = nextCursor;
        return dto;
    }
}

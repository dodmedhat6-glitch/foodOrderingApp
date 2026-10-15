import {inject, injectable} from "tsyringe";
import {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {logger} from "../../../lib/logger/logger";
import {wsChannels, wsPublish} from "../../../lib/websocket/publisher";
import {
    buildPaginationResultBy,
    PaginationParams,
} from "../../../lib/http/pagination/cursor-pagination";
import {OrderEntity} from "../../order/entity/order.entity";
import {estimateEarningMinor} from "../../delivery/service/assignment.service";
import {AgentEarningsResponseDTO, AgentWsEvent} from "../dto/agent.response.dto";
import {createEarningIfNew, findEarningsByAgent, sumEarningsByAgent} from "../repository/agent-earning.repo";
import {PresenceService} from "./presence.service";
import {EarningsRange} from "../types";

/**
 * The agent's own view of themselves: where they are, and what they have
 * earned. The orders they carry belong to the delivery module — this one never
 * writes an order.
 */
@injectable()
export class AgentService {
    constructor(@inject(TOKENS.PresenceService) private readonly presence: PresenceService) {}

    /**
     * Records what a delivery paid, inside the settlement transaction.
     *
     * `ON CONFLICT (order_id) DO NOTHING` underneath, so a replayed
     * settlement writes nothing the second time. That unique constraint — not
     * any check in this method — is what makes a double `delivered` a no-op
     * rather than a double payout (CLAUDE.md s8).
     *
     * Priced by the same function the offer used, so the estimate an agent saw
     * and the figure they are paid come from one place and cannot drift. The
     * result is *stamped*: a later rate change must not restate last month's
     * earnings.
     */
    recordEarning = async (
        order: OrderEntity,
        agentId: number,
        distanceMeters: number,
        conn: Knex,
    ): Promise<void> => {
        await createEarningIfNew(
            {
                region: order.region,
                agentId,
                orderId: order.id,
                orderPublicId: order.publicId,
                amount: estimateEarningMinor(distanceMeters),
                currency: order.currency,
                distanceMeters,
            },
            conn,
        );
    };

    /**
     * `GET /api/agents/earnings` — the list and the totals for a range.
     *
     * Two queries on purpose. The totals cover the whole range while the list
     * covers one page, so summing the page would report a number that silently
     * changed as the agent scrolled. Both run off
     * idx_agent_earnings_agent_earned_at.
     *
     * Never touches `orders`: the public id on every row is denormalised onto
     * `agent_earnings`, so a month of earnings costs no cross-partition
     * lookups and keeps resolving after archival.
     */
    listEarnings = async (
        agentId: number,
        range: EarningsRange,
        params: PaginationParams,
        region: string,
    ): Promise<AgentEarningsResponseDTO> => {
        const conn = db(region);
        const rows = await findEarningsByAgent(agentId, range, params, conn);
        const totals = await sumEarningsByAgent(agentId, range, conn);

        const page = buildPaginationResultBy(rows, params.limit, (row) =>
            String(row.earnedAt.getTime()),
        );

        return AgentEarningsResponseDTO.from(range, totals, page.data, page.meta.nextCursor);
    };

    /**
     * Registers an agent at a position and, if they are carrying an order,
     * forwards the position to that customer.
     *
     * The active order is read from **presence**, never from `orders`. A ping
     * arrives every 30 seconds from every online agent; making it a database
     * query would turn the fleet's heartbeat into the service's busiest read.
     * The copy in Redis is written when the claim commits and cleared when the
     * delivery settles, and if it is missing the customer simply gets no live
     * position — which is a cosmetic loss, not a correctness one.
     */
    recordPosition = async (
        region: string,
        agentId: number,
        lat: number,
        lng: number,
    ): Promise<void> => {
        await this.presence.touch(region, agentId, lat, lng);

        const active = await this.presence.getActiveOrder(region, agentId);
        if (!active) return;

        wsPublish([wsChannels.customer(active.customerId)], AgentWsEvent.POSITION, {
            orderPublicId: active.orderPublicId,
            lat,
            lng,
            ts: new Date().toISOString(),
        });
    };

    /** Drops the agent out of dispatch. Idempotent. */
    goOffline = async (region: string, agentId: number): Promise<void> => {
        await this.presence.goOffline(region, agentId);
        logger.info("agent offline", {region, agentId});
    };
}

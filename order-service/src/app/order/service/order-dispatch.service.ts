import {Knex} from "knex";
import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {
    buildPaginationResultBy,
    PaginationMeta,
    PaginationParams,
} from "../../../lib/http/pagination/cursor-pagination";
import {OrderEntity} from "../entity/order.entity";
import {OrderActor, OrderStatus} from "../enums";
import {AgentOrderFilters} from "../types";
import {
    claimOrderForAgent,
    findActiveOrderForAgent,
    findOrdersByAgent,
    findUnclaimedDispatchableOrders,
    releaseOrderFromAgent,
} from "../repository/order.repo";
import {recentWindow} from "../windows";
import {OrderStatusService} from "./order-status.service";

/** How far back `GET /api/agents/tasks` looks when the caller names no range. */
const AGENT_TASK_WINDOW_DAYS = 30;

/**
 * The dispatch surface of the `orders` table.
 *
 * The delivery module owns *when* an order is claimed, released or settled;
 * this module owns the `orders` table. Cross-module reads and writes go
 * through services, never repositories (CLAUDE.md s3), so these are the thin
 * data operations the delivery module composes. The policy — presence checks,
 * broadcasts, money — deliberately lives there, not here.
 */
@injectable()
export class OrderDispatchService {
    constructor(
        @inject(TOKENS.OrderStatusService) private readonly statusService: OrderStatusService,
    ) {}

    /**
     * Attempts the claim. Resolves to the updated order, or `undefined` when
     * another agent got there first.
     *
     * `undefined` is an ordinary outcome, not a failure — several agents are
     * offered the same order on purpose and all but one must lose. The
     * conditional UPDATE underneath is what decides it (order.repo), which is
     * why nothing here takes a lock.
     */
    claimForAgent = async (
        order: OrderEntity,
        agentId: number,
        conn: Knex = db(order.region),
    ): Promise<OrderEntity | undefined> => {
        // Validated even though the UPDATE's own predicate would catch it:
        // being the system is permission to traverse the system's edges, not
        // licence to invent one (same rule as `transitionBySystem`). A claim
        // on a `preparing` order moves no status, so it has no edge to check;
        // the UPDATE may still write `ready -> assigned` if the kitchen beat
        // it, which is the edge asserted here.
        this.statusService.assertTransition(
            OrderStatus.READY,
            OrderStatus.ASSIGNED,
            OrderActor.SYSTEM,
        );
        return claimOrderForAgent(order.id, order.createdAt, agentId, conn);
    };

    /**
     * The inverse. `undefined` when the agent no longer holds it. Only an
     * `assigned` order changes status (back to `ready`); a `preparing` one
     * just loses its agent.
     */
    releaseFromAgent = async (
        order: OrderEntity,
        agentId: number,
        conn: Knex = db(order.region),
    ): Promise<OrderEntity | undefined> => {
        if (order.status === OrderStatus.ASSIGNED) {
            this.statusService.assertTransition(
                OrderStatus.ASSIGNED,
                OrderStatus.READY,
                OrderActor.SYSTEM,
            );
        }
        return releaseOrderFromAgent(order.id, order.createdAt, agentId, conn);
    };

    /**
     * The order an agent is currently carrying, read from `orders`.
     *
     * Every decision that assigns or releases work asks this rather than the
     * presence hash. The hash holds a copy so the candidate scan is cheap, but
     * it lives in Redis and is allowed to vanish — so it answers "probably
     * busy", and this answers "busy".
     */
    findActiveForAgent = async (
        agentId: number,
        region: string,
    ): Promise<OrderEntity | undefined> => findActiveOrderForAgent(agentId, db(region));

    /** One page of an agent's tasks, as entities for the delivery module to shape. */
    listForAgent = async (
        agentId: number,
        params: PaginationParams,
        filters: AgentOrderFilters,
        region: string,
    ): Promise<{data: OrderEntity[]; meta: PaginationMeta}> => {
        const orders = await findOrdersByAgent(
            agentId,
            params,
            filters,
            recentWindow(AGENT_TASK_WINDOW_DAYS),
            db(region),
        );

        return buildPaginationResultBy(orders, params.limit, (order) =>
            String(order.createdAt.getTime()),
        );
    };

    /**
     * The dispatch sweep's input: `preparing` and `ready` orders nobody has
     * claimed, `ready` first.
     *
     * Bounded to recent months because an order that has been waiting longer
     * than the window is not waiting for an agent any more — it is a support
     * case, and sweeping it forever would mean re-offering it forever.
     */
    findUnclaimedDispatchable = async (region: string, limit: number): Promise<OrderEntity[]> =>
        findUnclaimedDispatchableOrders(recentWindow(AGENT_TASK_WINDOW_DAYS), limit, db(region));
}

import {inject, injectable} from "tsyringe";
import {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {logger} from "../../../lib/logger/logger";
import {getBranch, getBranches} from "../../../lib/core-client/branch.client";
import {tryGetUser} from "../../../lib/core-client/user.client";
import {wsChannels, wsPublish} from "../../../lib/websocket/publisher";
import {PaginationMeta, PaginationParams} from "../../../lib/http/pagination/cursor-pagination";
import {OrderEntity} from "../../order/entity/order.entity";
import {OrderActor, OrderStatus} from "../../order/enums";
import {AgentOrderFilters} from "../../order/types";
import {OrderService} from "../../order/service/order.service";
import {countItemsByOrderIds} from "../../order/repository/order-item.repo";
import {PresenceService} from "../../agent/service/presence.service";
import {AgentService} from "../../agent/service/agent.service";
import {PaymentService} from "../../payment/service/payment.service";
import {FinanceService} from "../../finance/service/finance.service";
import {DeliverySummaryResponseDTO, DeliveryTaskResponseDTO} from "../dto/delivery.response.dto";
import {DeliveryWsEvent} from "../enums";
import {
    AgentInActiveDeliveryError,
    AgentNotFoundError,
    CannotUnclaimAfterPickupError,
    NotOnlineError,
    NotYourDeliveryError,
    OrderAlreadyAssignedError,
    OrderNotReadyError,
} from "../errors";
import {AssignmentService} from "./assignment.service";

/**
 * The delivery half of an order's life: claiming it, handing it back, carrying
 * it, and settling the money when it lands.
 *
 * Holds no table of its own. A delivery is a phase of an order
 * (docs/database-design.md s3.7), so every read and write here goes through
 * `OrderService` — cross-module calls go via services, never repositories
 * (CLAUDE.md s3). What this module owns is the *policy*: who may claim, what a
 * claim costs, and what has to be true before money moves.
 */
@injectable()
export class DeliveryService {
    constructor(
        @inject(TOKENS.OrderService) private readonly orders: OrderService,
        @inject(TOKENS.PresenceService) private readonly presence: PresenceService,
        @inject(TOKENS.AgentService) private readonly agents: AgentService,
        @inject(TOKENS.AssignmentService) private readonly assignment: AssignmentService,
        @inject(TOKENS.PaymentService) private readonly payments: PaymentService,
        @inject(TOKENS.FinanceService) private readonly finance: FinanceService,
    ) {}

    /**
     * `POST /api/orders/{publicId}/claim` — an agent takes an offered order.
     *
     * **The claim is the assignment.** There is no accept step to follow,
     * which is why there is no accept timeout anywhere in this service and no
     * `accepted` state on the order.
     *
     * The checks before the UPDATE are courtesy, not safety: they turn the
     * common refusals into specific errors instead of a bare "somebody won".
     * The safety is the conditional UPDATE itself, which is the only thing
     * standing between several agents offered the same order — and the only
     * check that still holds if Redis has lost every byte of presence.
     */
    claim = async (
        publicId: string,
        agentId: number,
        region: string,
    ): Promise<DeliveryTaskResponseDTO> => {
        const order = await this.orders.findByPublicId(publicId, db(region));
        if (order.status !== OrderStatus.READY) throw OrderNotReadyError;

        if (!(await this.presence.isOnline(region, agentId))) throw NotOnlineError;
        if (await this.orders.findActiveForAgent(agentId, region)) {
            throw AgentInActiveDeliveryError;
        }

        return this.assignTo(order, agentId, region);
    };

    /**
     * `POST /api/orders/{publicId}/assign` — admin override.
     *
     * Skips the offer round and the presence check: an admin assigning by hand
     * is usually doing it *because* the agent's app is misbehaving, so
     * requiring a live presence entry would block the exact case this exists
     * for. The one-active-order rule still applies — that is about the agent's
     * capacity to carry food, which no amount of admin intent changes.
     */
    assignByAdmin = async (
        publicId: string,
        agentId: number,
        region: string,
    ): Promise<DeliveryTaskResponseDTO> => {
        const order = await this.orders.findByPublicId(publicId, db(region));
        if (order.status !== OrderStatus.READY) throw OrderNotReadyError;

        // Confirms the agent exists in core before attaching an order to an id
        // that might be a typo. `delivery_agent_id` is a logical FK, so this
        // check is the only thing that enforces it.
        if (!(await tryGetUser(agentId))) throw AgentNotFoundError;

        if (await this.orders.findActiveForAgent(agentId, region)) {
            throw AgentInActiveDeliveryError;
        }

        logger.info("admin force-assign", {orderPublicId: publicId, agentId, region});
        return this.assignTo(order, agentId, region);
    };

    /**
     * `POST /api/orders/{publicId}/unclaim` — the agent hands it back.
     *
     * Only from `assigned`. From `picked` it is 409: the food is in the
     * agent's bag, and recovering it is an exceptions flow that is out of
     * scope (CLAUDE.md s13). The release is scoped to the agent who holds the
     * order, so one agent can never free another's work.
     */
    unclaim = async (publicId: string, agentId: number, region: string): Promise<void> => {
        const order = await this.orders.findByPublicId(publicId, db(region));
        if (order.deliveryAgentId !== agentId) throw NotYourDeliveryError;
        if (order.status === OrderStatus.PICKED) throw CannotUnclaimAfterPickupError;
        if (order.status !== OrderStatus.ASSIGNED) throw OrderNotReadyError;

        const released = await this.orders.releaseFromAgent(order, agentId);
        if (!released) throw NotYourDeliveryError;

        await this.presence.setActiveOrder(region, agentId, null);
        // Offer history is cleared so the order re-enters the pool at round
        // one. It was claimed, so the earlier rounds told us nothing about how
        // hard it is to dispatch — only that this particular agent changed
        // their mind.
        await this.assignment.clearAttempts(order.publicId);
        await this.orders.announceTransition(released);

        logger.info("order unclaimed", {orderPublicId: publicId, agentId, region});
    };

    /**
     * Frees whatever the agent is carrying before they go offline.
     *
     * `assigned` → hand it back, so it returns to the pool and the next sweep
     * re-offers it. Leaving it attached would strand an order on an agent who
     * has closed the app, and nothing would notice until a customer complained.
     *
     * `picked` → 409. The food is in their bag; going offline is not
     * something they get to do, and the honest answer is to say so rather than
     * to release an order whose contents have physically left the branch.
     *
     * Reads `orders`, not presence: this decision releases work, so it asks the
     * durable copy.
     */
    releaseActiveOnGoingOffline = async (agentId: number, region: string): Promise<void> => {
        const active = await this.orders.findActiveForAgent(agentId, region);
        if (!active) return;

        if (active.status === OrderStatus.PICKED) throw CannotUnclaimAfterPickupError;
        await this.unclaim(active.publicId, agentId, region);
    };

    /**
     * `assigned → picked`, the agent confirming pickup at the branch.
     *
     * No money moves and no transaction is needed: one row, one status, one
     * timestamp.
     */
    markPicked = async (order: OrderEntity, agentId: number): Promise<OrderEntity> => {
        this.assertOwnedBy(order, agentId);

        const picked = await this.orders.transitionInTrx(
            order,
            OrderStatus.PICKED,
            OrderActor.AGENT,
            db(order.region),
        );

        await this.orders.announceTransition(picked);
        return picked;
    };

    /**
     * The agent-side transitions, reached through the order module's single
     * status endpoint rather than endpoints of their own.
     *
     * `PATCH /api/orders/{publicId}/status` stays the one way to move an
     * order (CLAUDE.md s4) — the status machine decides which targets each
     * actor may ask for, and `OrderService.updateStatus` routes the two an
     * agent owns here, because `delivered` is not a status change but a
     * settlement that happens to end in one.
     */
    handleAgentTransition = async (
        order: OrderEntity,
        target: OrderStatus,
        agentId: number,
    ): Promise<OrderEntity> => {
        if (target === OrderStatus.PICKED) return this.markPicked(order, agentId);
        if (target === OrderStatus.DELIVERED) return this.markDelivered(order, agentId);

        // Unreachable: the caller only routes the two targets above. Throwing
        // rather than falling through to a plain status write, so a third
        // agent-owned target added later cannot silently skip its side effects.
        throw NotYourDeliveryError;
    };

    /**
     * `picked → delivered`, and the settlement that goes with it.
     *
     * One transaction, and the ordering inside it is not arbitrary
     * (docs/business-logic/restaurant-finance.md s7):
     *
     *  1. **Lock the restaurant's balance row first.** The commission is
     *     computed from values read before the write, so taking the lock up
     *     front is what makes the whole read-compute-write sequence serial per
     *     restaurant rather than just the final UPDATE.
     *  2. Ledger rows — the COD collection (cash only) and the commission.
     *  3. Credit the balance by `subtotal - commission`.
     *  4. The agent's earning.
     *  5. The status flip, carrying the commission in the same UPDATE so a
     *     settled order and its commission can never disagree.
     *
     * Every one of those writes is idempotent — two unique constraints and a
     * compare-and-set — so a replayed `delivered` is a no-op rather than a
     * second payout. That is the property worth testing, not the happy path.
     *
     * **Nothing upstream is called inside the transaction.** The branch
     * projection is read before it opens: an HTTP round trip while holding a
     * row lock on a restaurant's money is how one slow upstream becomes a
     * queue of blocked deliveries.
     */
    markDelivered = async (order: OrderEntity, agentId: number): Promise<OrderEntity> => {
        this.assertOwnedBy(order, agentId);
        const region = order.region;

        const branch = await getBranch(order.branchId);
        const commission = Math.min(
            Math.floor(order.subtotal * commissionRate(branch.commission)),
            // ck_orders_commission_le_subtotal — a misconfigured rate must
            // fail the rate, not the delivery.
            order.subtotal,
        );
        const distanceMeters = Math.round(this.assignment.tripDistanceMeters(order, branch));

        const conn = db(region);
        const trx = await conn.transaction();
        let delivered: OrderEntity;
        try {
            await this.finance.creditForDelivery(
                order.restaurantId,
                order.currency,
                order.region,
                order.subtotal - commission,
                trx,
            );
            await this.payments.recordDeliverySettlement(order, commission, null, trx);
            await this.agents.recordEarning(order, agentId, distanceMeters, trx);

            delivered = await this.orders.transitionInTrx(
                order,
                OrderStatus.DELIVERED,
                OrderActor.AGENT,
                trx,
                {commission},
            );

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        // Post-commit, best-effort, in that order: free the agent before
        // telling anyone, so an agent who reads the broadcast and immediately
        // asks for more work is already eligible for it.
        await this.presence.setActiveOrder(region, agentId, null);
        await this.orders.announceTransition(delivered);

        logger.info("delivery settled", {
            orderPublicId: order.publicId,
            agentId,
            region,
            commission,
            distanceMeters,
        });

        return delivered;
    };

    /** `GET /api/agents/tasks` — one page of the agent's work. */
    listTasks = async (
        agentId: number,
        params: PaginationParams,
        filters: AgentOrderFilters,
        region: string,
    ): Promise<{data: DeliveryTaskResponseDTO[]; meta: PaginationMeta}> => {
        const page = await this.orders.listForAgent(agentId, params, filters, region);
        return {data: await this.toTasks(page.data, region), meta: page.meta};
    };

    /**
     * The delivery block on `GET /api/orders/{publicId}` — who is bringing it.
     *
     * Returns undefined before an agent is attached, so the field is simply
     * absent on an order still in the kitchen rather than present and empty.
     */
    summarize = async (order: OrderEntity): Promise<DeliverySummaryResponseDTO | undefined> => {
        if (!order.deliveryAgentId) return undefined;

        // `tryGetUser` and not `getUser`: a customer tracking a delivery must
        // not get a 502 because the courier's *name* could not be fetched.
        const agent = await tryGetUser(order.deliveryAgentId);
        return DeliverySummaryResponseDTO.from(
            order,
            agent ? {id: agent.id, name: agent.name} : undefined,
        );
    };

    /**
     * Offers a freshly-`ready` order immediately, instead of waiting for the
     * next sweep tick.
     *
     * A convenience, not a mechanism. If this never ran, every order would
     * still be offered — just up to `ASSIGNMENT_SWEEP_SEC` later. Keeping that
     * true is what lets the whole path be best-effort: the caller swallows
     * failures here precisely because the sweep is the guarantee.
     */
    nudgeDispatch = async (order: OrderEntity): Promise<void> => {
        const branch = await getBranch(order.branchId);
        const [count] = await countItemsByOrderIds([order.id], db(order.region));
        await this.assignment.offer(order, branch, count?.count ?? 0);
    };

    /**
     * Releases the agent carrying an order that has just been cancelled.
     *
     * Called by whoever cancelled it, after the cancellation commits. The
     * order row already lost its agent as part of that transition; this is the
     * Redis side plus the courtesy of telling them, so they stop driving to a
     * branch that no longer has food for them.
     */
    releaseOnCancellation = async (order: OrderEntity, reason?: string): Promise<void> => {
        if (!order.deliveryAgentId) return;

        await this.presence.setActiveOrder(order.region, order.deliveryAgentId, null);
        await this.assignment.clearAttempts(order.publicId);
        wsPublish([wsChannels.agent(order.deliveryAgentId)], DeliveryWsEvent.CANCELLED, {
            orderPublicId: order.publicId,
            reason,
        });
    };

    /**
     * The claim itself, shared by the agent path and the admin override.
     *
     * `undefined` from `claimForAgent` means the conditional UPDATE matched
     * nothing — somebody else won the race, or the order moved. Either way the
     * answer to this caller is the same.
     */
    private assignTo = async (
        order: OrderEntity,
        agentId: number,
        region: string,
    ): Promise<DeliveryTaskResponseDTO> => {
        const assigned = await this.orders.claimForAgent(order, agentId);
        if (!assigned) throw OrderAlreadyAssignedError;

        await this.presence.setActiveOrder(region, agentId, {
            orderId: assigned.id,
            orderPublicId: assigned.publicId,
            customerId: assigned.customerId,
        });
        await this.assignment.clearAttempts(assigned.publicId);

        const task = await this.toTask(assigned);

        wsPublish([wsChannels.agent(agentId)], DeliveryWsEvent.ASSIGNED, task);
        // The losers are told their offer is dead rather than finding out by
        // claiming it. Best-effort: if the offer list has expired they fall
        // back to the 409, which their client must handle regardless.
        await this.assignment.announceTaken(assigned.publicId, agentId);
        await this.orders.announceTransition(assigned);

        logger.info("order claimed", {
            orderPublicId: assigned.publicId,
            agentId,
            region,
        });

        return task;
    };

    /**
     * 403 and not 404: the agent was told this order exists by an offer, so
     * acknowledging it leaks nothing. (The order module returns 404 to a
     * customer probing somebody else's id, where the existence *is* the leak.)
     */
    private assertOwnedBy = (order: OrderEntity, agentId: number): void => {
        if (order.deliveryAgentId !== agentId) throw NotYourDeliveryError;
    };

    /** One order as an agent-facing task. */
    private toTask = async (
        order: OrderEntity,
        branch?: Awaited<ReturnType<typeof getBranch>>,
    ): Promise<DeliveryTaskResponseDTO> => {
        const resolved = branch ?? (await getBranch(order.branchId));
        const [count] = await countItemsByOrderIds([order.id], db(order.region));
        return this.assignment.buildTask(order, resolved, count?.count ?? 0);
    };

    /**
     * A page of orders as tasks — branch projections and item counts both
     * batched, so a 20-row page is two reads rather than forty (CLAUDE.md s9).
     */
    private toTasks = async (
        orders: OrderEntity[],
        region: string,
    ): Promise<DeliveryTaskResponseDTO[]> => {
        if (orders.length === 0) return [];

        const branches = await getBranches(orders.map((order) => order.branchId));
        const counts = await countItemsByOrderIds(
            orders.map((order) => order.id),
            db(region),
        );
        const countByOrderId = new Map(counts.map((c) => [c.orderId, c.count]));

        const tasks: DeliveryTaskResponseDTO[] = [];
        for (const order of orders) {
            const branch = branches.get(order.branchId);
            // An order whose branch projection is unreachable is dropped from
            // the page rather than rendered with holes where the pickup
            // address should be — an agent cannot act on a task with no
            // address, and a half-rendered one invites them to try.
            if (!branch) continue;
            tasks.push(
                this.assignment.buildTask(order, branch, countByOrderId.get(order.id) ?? 0),
            );
        }
        return tasks;
    };
}

/**
 * Core reports `commission` per branch, and has been seen sending it both as a
 * fraction (`0.15`) and as a percentage (`15`). Treating 15 as a fraction
 * would charge a restaurant fifteen times its subtotal, so anything above 1 is
 * read as a percentage.
 *
 * The ambiguity is core's to resolve; until it does, this is the reading that
 * fails safe — and the `ck_orders_commission_le_subtotal` constraint plus the
 * `Math.min` at the call site are the backstop if it is ever wrong.
 */
function commissionRate(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw > 1 ? raw / 100 : raw;
}

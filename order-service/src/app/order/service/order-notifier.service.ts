import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {wsChannels, wsPublish} from "../../../lib/websocket/publisher";
import {OrderEntity} from "../entity/order.entity";
import {OrderStatus, OrderWsEvent} from "../enums";
import {countItemsByOrderIds} from "../repository/order-item.repo";
import {OrderSummaryResponseDTO} from "../dto/order.response.dto";

/**
 * The post-commit chores every order transition owes: tell the sockets and
 * drop the branch's cached dashboard pages.
 *
 * One service for every caller — placement, the status endpoint, the payment
 * webhook, dispatch — because a transition that broadcasts differently
 * depending on which module wrote it is a bug waiting to happen: the kitchen's
 * view of an order must not depend on who moved it.
 *
 * Everything here is best-effort. It runs after the write is durable, and
 * turning a notification failure into an error would tell the caller their
 * transition failed when it did not.
 */
@injectable()
export class OrderNotifier {
    constructor(@inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider) {}

    /** A COD order, visible to the kitchen the moment it is written. */
    announceCreated = async (order: OrderEntity, itemsCount: number): Promise<void> => {
        this.publishCreated(order, itemsCount);
        await this.invalidateBranchOrderLists(order.branchId);
    };

    /**
     * An online order that has just become visible to the restaurant, called
     * by the payment module after a capture commits. The customer is told too:
     * for them it is a move out of `pending_payment`.
     */
    announcePlacement = async (order: OrderEntity): Promise<void> => {
        const [count] = await countItemsByOrderIds([order.id], db(order.region));

        this.publishCreated(order, count?.count ?? 0);
        this.publishStatusChange(order);
        await this.invalidateBranchOrderLists(order.branchId);
    };

    announceTransition = async (order: OrderEntity, reason?: string): Promise<void> => {
        this.publishStatusChange(order, reason);
        await this.invalidateBranchOrderLists(order.branchId);
    };

    /**
     * The `order.created` broadcast — the moment an order becomes visible to
     * the restaurant. For COD that is placement; for an online order it is
     * the capture.
     */
    private publishCreated = (order: OrderEntity, itemsCount: number): void => {
        wsPublish(
            [wsChannels.branch(order.branchId), wsChannels.restaurant(order.restaurantId)],
            OrderWsEvent.CREATED,
            OrderSummaryResponseDTO.from(order, itemsCount),
        );
    };

    private publishStatusChange = (order: OrderEntity, reason?: string): void => {
        const channels = [
            wsChannels.customer(order.customerId),
            wsChannels.branch(order.branchId),
        ];
        if (order.deliveryAgentId) channels.push(wsChannels.agent(order.deliveryAgentId));

        const ts = new Date().toISOString();
        if (order.status === OrderStatus.CANCELLED) {
            wsPublish(channels, OrderWsEvent.CANCELLED, {orderId: order.publicId, reason, ts});
            return;
        }
        wsPublish(channels, OrderWsEvent.STATUS_CHANGED, {
            orderId: order.publicId,
            status: order.status,
            ts,
        });
    };

    /**
     * Explicit invalidation after every transition, because the restaurant
     * dashboard is cached and a kitchen looking at a stale queue is the exact
     * failure the cache is supposed to be invisible for (CLAUDE.md s8/Cache).
     */
    private invalidateBranchOrderLists = async (branchId: number): Promise<void> => {
        // One cached page per filter/cursor permutation, all keyed
        // `<region>:restaurant:orders:<branchId>:...` by the route's key
        // builder (app/order/routes.ts), so the branch's whole family goes in
        // one pattern delete. Best-effort: a Redis failure must not fail a
        // transition that has already committed — the 10s TTL is the backstop.
        await this.cache.delByPattern(`*restaurant:orders:${branchId}:*`).catch(() => {});
    };
}

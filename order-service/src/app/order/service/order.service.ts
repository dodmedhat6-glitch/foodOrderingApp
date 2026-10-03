import {inject, injectable} from "tsyringe";
import {Knex} from "knex";
import {AppError} from "../../../lib/error/AppError";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {TOKENS} from "../../../lib/di/tokens";
import {env} from "../../../lib/config/env";
import {logger} from "../../../lib/logger/logger";
import {db} from "../../../lib/knex/knex";
import {isRegion} from "../../../lib/sharding/regions";
import {newPublicId, timestampFromUuidV7} from "../../../pkg/utils/uuid";
import {toMs} from "../../../pkg/utils/time";
import {getBranch, reserveStock} from "../../../lib/core-client/branch.client";
import {getBranchProducts} from "../../../lib/core-client/product.client";
import {getCustomerAddress} from "../../../lib/core-client/address.client";
import {branchRejectingOrdersKey} from "../../../lib/core-client/cache-keys";
import {CoreCallContext} from "../../../lib/core-client/types";
import {wsChannels, wsPublish} from "../../../lib/websocket/publisher";
import {
    buildPaginationResultBy,
    PaginationMeta,
    PaginationParams,
} from "../../../lib/http/pagination/cursor-pagination";
import {SystemRole} from "../../../lib/auth/roles";
import {OrderEntity} from "../entity/order.entity";
import {OrderItemEntity} from "../entity/order-item.entity";
import {OrderActor, OrderStatus, OrderWsEvent, PaymentMethod} from "../enums";
import {
    AddressNotOwnedError,
    BranchNotAcceptingOrdersError,
    CancellationWindowExpiredError,
    DuplicateProductInOrderError,
    OrderNotFoundError,
    OutOfStockLine,
    outOfStockError,
} from "../errors";
import {
    CreatedAtWindow,
    createOrder,
    findOrderByPublicId,
    findOrdersByBranch,
    findOrdersByCustomer,
    updateOrderStatus,
} from "../repository/order.repo";
import {
    bulkInsertItems,
    countItemsByOrderIds,
    findItemsByOrderIds,
} from "../repository/order-item.repo";
import {CreateOrderItemInput, ListOrdersFilters, PricedOrderLine} from "../types";
import {CreateOrderRequestDTO} from "../dto/order.request.dto";
import {
    OrderDetailResponseDTO,
    OrderPaymentSummaryDTO,
    OrderResponseDTO,
    OrderStatusResponseDTO,
    OrderSummaryResponseDTO,
} from "../dto/order.response.dto";
import {OrderStatusService} from "./order-status.service";

/** The authenticated caller, as resolved from the JWT by the controller. */
export interface OrderRequester {
    userId: number;
    role: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}

export interface PlaceOrderContext extends CoreCallContext {
    region: string;
}

// Slack on either side of the UUIDv7 timestamp when deriving the partition
// window for a public-id lookup. The id is minted a few milliseconds before
// created_at is stamped, and a generous margin costs at most one extra
// partition probe while making a month-boundary straddle impossible.
const PUBLIC_ID_WINDOW_MS = toMs(1, "m");

@injectable()
export class OrderService {
    constructor(
        @inject(TOKENS.OrderStatusService) private readonly statusService: OrderStatusService,
        @inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider,
    ) {}

    /**
     * Places an order (docs/business-logic/orders.md s2).
     *
     * Validation reads core through the cached clients, money is computed in
     * minor units, and the header plus its lines are written in one
     * transaction. Stock is reserved in core *after* that commit, on purpose:
     * core's decrement is a separate database that cannot join our
     * transaction, and holding our rows locked across an HTTP round trip is
     * what would actually hurt at this service's write rate. The window is
     * seconds wide and a failure compensates by cancelling the order.
     */
    placeOrder = async (
        input: CreateOrderRequestDTO,
        requester: OrderRequester,
        ctx: PlaceOrderContext,
    ): Promise<OrderResponseDTO> => {
        const lineByProduct = new Map<number, number>();
        for (const item of input.items) {
            if (lineByProduct.has(item.productId)) throw DuplicateProductInOrderError;
            lineByProduct.set(item.productId, item.quantity);
        }

        const branch = await getBranch(input.branchId, ctx);
        await this.assertBranchAcceptsOrders(branch.id, branch);

        const region = branch.countryCode.toLowerCase();
        if (!isRegion(region)) {
            throw new AppError(`Branch ${branch.id} is in unconfigured region "${region}"`, 503);
        }
        // The shard is the branch's country, so a mismatched X-Region would
        // mean writing the order somewhere the idempotency record isn't. Fail
        // loudly rather than silently retargeting.
        if (ctx.region !== region) {
            throw new AppError(`OrderRegionMismatch: branch ${branch.id} belongs to region "${region}"`, 409);
        }

        const address = await getCustomerAddress(input.customerAddressId, ctx);
        if (address.customerId !== requester.userId) throw AddressNotOwnedError;

        const lines = await this.priceLines(input.branchId, lineByProduct, ctx);

        const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
        const deliveryFee = branch.deliveryFeeMinor;
        const serviceFee = Math.floor((subtotal * env.orders.serviceFeeBps) / 10_000);
        const total = subtotal + deliveryFee + serviceFee;

        const isOnline = input.paymentMethod === PaymentMethod.ONLINE;
        const publicId = newPublicId();
        const conn = db(region);

        // COD is in the restaurant's queue immediately; an online order isn't
        // placed until Kashier confirms the capture (Phase 2).
        const status = isOnline ? OrderStatus.PENDING_PAYMENT : OrderStatus.PLACED;

        const trx = await conn.transaction();
        let order: OrderEntity;
        let items: OrderItemEntity[];
        try {
            order = await createOrder(
                {
                    region,
                    publicId,
                    countryCode: branch.countryCode,
                    restaurantId: branch.restaurantId,
                    branchId: branch.id,
                    customerId: requester.userId,
                    customerAddressId: address.id,
                    deliveryLat: address.lat,
                    deliveryLng: address.lng,
                    deliveryAddressTextSnapshot: address.addressText,
                    branchNameSnapshot: branch.name,
                    restaurantNameSnapshot: branch.restaurantName,
                    status,
                    subtotal,
                    deliveryFee,
                    serviceFee,
                    total,
                    currency: branch.currency,
                    paymentMethod: input.paymentMethod,
                    placedAt: isOnline ? null : new Date(),
                },
                trx,
            );

            items = await bulkInsertItems(order.id, lines.map(toItemInput(region)), trx);

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        await this.reserveStockOrVoid(order, lineByProduct, conn, ctx);

        // Online orders stay invisible to the kitchen until payment lands.
        if (!isOnline) {
            wsPublish(
                [wsChannels.branch(order.branchId), wsChannels.restaurant(order.restaurantId)],
                OrderWsEvent.CREATED,
                OrderSummaryResponseDTO.from(order, items.length),
            );
            await this.invalidateBranchOrderLists(order.branchId);
        }

        return OrderResponseDTO.from(order, items);
    };

    /** GET /api/orders/{publicId} — header, lines, payment summary, timeline. */
    getOrder = async (
        publicId: string,
        region: string,
        requester: OrderRequester,
    ): Promise<OrderDetailResponseDTO> => {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn, publicIdWindow(publicId));
        if (!order) throw OrderNotFoundError;

        this.assertCanReadOrder(order, requester);

        const items = await findItemsByOrderIds([order.id], conn);
        return OrderDetailResponseDTO.fromDetail(order, items, this.paymentSummary(order));
    };

    /**
     * GET /api/customer/orders?year=YYYY. The year bounds the scan to that
     * year's partitions; it defaults to the current one, which is the only
     * year the hot database keeps (CLAUDE.md s7/Archival).
     */
    listCustomerOrders = async (
        requester: OrderRequester,
        region: string,
        params: PaginationParams,
        year: number,
    ): Promise<{data: OrderSummaryResponseDTO[]; meta: PaginationMeta}> => {
        const conn = db(region);
        const orders = await findOrdersByCustomer(requester.userId, params, yearWindow(year), conn);
        return this.toSummaryPage(orders, params, conn);
    };

    /** GET /api/restaurant/orders — branch-scoped operations dashboard. */
    listRestaurantOrders = async (
        branchId: number,
        params: PaginationParams,
        filters: ListOrdersFilters,
        region: string,
    ): Promise<{data: OrderSummaryResponseDTO[]; meta: PaginationMeta}> => {
        const conn = db(region);
        const orders = await findOrdersByBranch(branchId, params, filters, conn);
        return this.toSummaryPage(orders, params, conn);
    };

    /**
     * PATCH /api/orders/{publicId}/status (docs/business-logic/orders.md s7).
     *
     * The actor is derived from the token, never from the body, and the
     * transition is validated against the status machine before anything is
     * written. The update itself is a compare-and-set on the current status,
     * so two restaurant staff accepting the same order at once produce one
     * transition and one 409 rather than two.
     */
    updateStatus = async (
        publicId: string,
        target: OrderStatus,
        reason: string | undefined,
        requester: OrderRequester,
        region: string,
    ): Promise<OrderStatusResponseDTO> => {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn, publicIdWindow(publicId));
        if (!order) throw OrderNotFoundError;

        this.assertCanReadOrder(order, requester);

        const actor = this.resolveActor(order, requester);
        this.statusService.assertReason(target, reason);
        const timestampColumn = this.statusService.assertTransition(order.status, target, actor);

        if (
            actor === OrderActor.CUSTOMER &&
            target === OrderStatus.CANCELLED &&
            !order.isWithinCustomerCancellationWindow(
                toMs(env.orders.customerCancellationWindowSec, "s"),
            )
        ) {
            throw CancellationWindowExpiredError;
        }

        const updated = await updateOrderStatus(
            order.id,
            order.createdAt,
            order.status,
            {status: target, statusReason: reason ?? null, timestampColumn},
            conn,
        );
        // Zero rows means the status moved under us between the read and the
        // write; the transition we validated is no longer the one on offer.
        if (!updated) throw OrderNotFoundError;

        await this.invalidateBranchOrderLists(updated.branchId);
        this.publishStatusChange(updated, reason);

        return OrderStatusResponseDTO.from(updated);
    };

    /**
     * Refuses an order when the branch, or the restaurant above it, isn't
     * trading. The Redis flag is checked as well as the projection because
     * `branch.deactivated` arrives as an event and must take effect
     * immediately, not when the branch projection's TTL lapses.
     */
    private assertBranchAcceptsOrders = async (
        branchId: number,
        branch: {isActive: boolean; acceptOrders: boolean; restaurantStatus: string},
    ): Promise<void> => {
        const flagged = await this.cache.get(branchRejectingOrdersKey(branchId)).catch(() => null);
        if (flagged) throw BranchNotAcceptingOrdersError;

        if (!branch.isActive || !branch.acceptOrders) throw BranchNotAcceptingOrdersError;
        if (branch.restaurantStatus !== "active") throw BranchNotAcceptingOrdersError;
    };

    /**
     * Resolves every line's price and availability in one upstream batch call,
     * and reports *all* offending lines at once so the customer can fix their
     * basket in a single pass.
     */
    private priceLines = async (
        branchId: number,
        quantityByProduct: Map<number, number>,
        ctx: CoreCallContext,
    ): Promise<PricedOrderLine[]> => {
        const productIds = [...quantityByProduct.keys()];
        const products = await getBranchProducts(branchId, productIds, ctx);
        const byId = new Map(products.map((p) => [p.id, p]));

        const offending: OutOfStockLine[] = [];
        const lines: PricedOrderLine[] = [];

        for (const [productId, quantity] of quantityByProduct) {
            const product = byId.get(productId);

            // A product the branch doesn't carry, has turned off, or can't
            // cover is reported through the same channel: from the customer's
            // side they all mean "you can't have this right now".
            if (!product || !product.isAvailable || product.stock < quantity) {
                offending.push({productId, requested: quantity, available: product?.stock ?? 0});
                continue;
            }

            lines.push({
                productId,
                quantity,
                unitPriceMinor: product.unitPriceMinor,
                nameSnapshot: product.name,
                imageUrlSnapshot: product.imageUrl,
                lineTotal: product.unitPriceMinor * quantity,
            });
        }

        if (offending.length > 0) throw outOfStockError(offending);
        return lines;
    };

    /**
     * Reserves the stock that the committed order claims. Core's decrement is
     * the authority on who got the last unit; if it refuses, the order we just
     * wrote can't be fulfilled, so it is cancelled and the customer gets the
     * 409 they would have got had the race gone the other way.
     */
    private reserveStockOrVoid = async (
        order: OrderEntity,
        quantityByProduct: Map<number, number>,
        conn: Knex,
        ctx: CoreCallContext,
    ): Promise<void> => {
        const items = [...quantityByProduct].map(([productId, quantity]) => ({productId, quantity}));

        try {
            await reserveStock(order.branchId, items, ctx);
        } catch (err) {
            await updateOrderStatus(
                order.id,
                order.createdAt,
                order.status,
                {
                    status: OrderStatus.CANCELLED,
                    statusReason: "out_of_stock_post_commit",
                    timestampColumn: "cancelled_at",
                },
                conn,
            ).catch((cancelErr: unknown) => {
                // The order is now stuck claiming stock it never got. Loud,
                // because it needs an operator — not a silent catch.
                logger.error("failed to void order after stock reservation failed", {
                    orderPublicId: order.publicId,
                    error: String(cancelErr),
                });
            });

            this.publishStatusChange(
                new OrderEntity({...order, status: OrderStatus.CANCELLED}),
                "out_of_stock_post_commit",
            );

            // The customer asked us for an order, not for a report on which
            // upstream said no. A lost race here is the same answer as losing
            // it in the pre-check, so it gets the same documented body
            // (docs/api-contracts.md s1.1) rather than core's envelope
            // stringified into a message.
            const lines = outOfStockLinesFromCoreError(err);
            if (lines) throw outOfStockError(lines);
            throw err;
        }
    };

    /** Items counts for a page of orders: one grouped query, never per row. */
    private toSummaryPage = async (
        orders: OrderEntity[],
        params: PaginationParams,
        conn: Knex,
    ): Promise<{data: OrderSummaryResponseDTO[]; meta: PaginationMeta}> => {
        const page = buildPaginationResultBy(orders, params.limit, (order) =>
            String(order.createdAt.getTime()),
        );

        const counts = await countItemsByOrderIds(
            page.data.map((order) => order.id),
            conn,
        );
        const countByOrderId = new Map(counts.map((c) => [c.orderId, c.count]));

        return {
            data: page.data.map((order) =>
                OrderSummaryResponseDTO.from(order, countByOrderId.get(order.id) ?? 0),
            ),
            meta: page.meta,
        };
    };

    /**
     * Invariant 6 and 7 (docs/business-logic/orders.md s8): a customer can
     * only read their own order even holding its public id, and a restaurant
     * user only the branches they belong to — an owner gets the whole
     * restaurant.
     */
    private assertCanReadOrder = (order: OrderEntity, requester: OrderRequester): void => {
        if (requester.role === SystemRole.SYSTEM_ADMIN) return;

        if (requester.role === SystemRole.CUSTOMER) {
            if (order.customerId !== requester.userId) throw OrderNotFoundError;
            return;
        }

        if (requester.role === SystemRole.RESTAURANT_USER) {
            if (Number(requester.restaurantId) !== order.restaurantId) throw OrderNotFoundError;
            if (requester.restaurantRole === "owner") return;
            if (!(requester.branchIds ?? []).some((id) => Number(id) === order.branchId)) {
                throw OrderNotFoundError;
            }
            return;
        }

        if (requester.role === SystemRole.DELIVERY_AGENT) {
            if (order.deliveryAgentId !== requester.userId) throw OrderNotFoundError;
            return;
        }

        throw OrderNotFoundError;
    };

    /**
     * Maps the caller's system role onto the actor the status machine reasons
     * about. 404 rather than 403 for an unknown role: by this point the
     * caller has already been shown to have no legitimate view of the order,
     * and confirming it exists tells them something they shouldn't learn.
     */
    private resolveActor = (order: OrderEntity, requester: OrderRequester): OrderActor => {
        switch (requester.role) {
            case SystemRole.SYSTEM_ADMIN:
                return OrderActor.ADMIN;
            case SystemRole.CUSTOMER:
                return OrderActor.CUSTOMER;
            case SystemRole.RESTAURANT_USER:
                return OrderActor.RESTAURANT;
            case SystemRole.DELIVERY_AGENT:
                return OrderActor.AGENT;
            default:
                throw OrderNotFoundError;
        }
    };

    /**
     * Phase 1 approximation. The authoritative payment state lives in
     * `transactions` / `payment_sessions`, which land in Phase 2; until then
     * it is derived from the order, which is enough for every state Phase 1
     * can actually reach.
     */
    private paymentSummary = (order: OrderEntity): OrderPaymentSummaryDTO => {
        let status: OrderPaymentSummaryDTO["status"] = "pending";
        if (order.paymentMethod === PaymentMethod.ONLINE) {
            if (order.status === OrderStatus.PENDING_PAYMENT) status = "pending";
            else if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED) {
                status = "refunded";
            } else status = "captured";
        } else if (order.status === OrderStatus.DELIVERED) {
            status = "captured";
        }

        return {
            method: order.paymentMethod,
            status,
            amount: order.total,
            currency: order.currency,
            refundedAmount: 0,
        };
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

function toItemInput(region: string) {
    return (line: PricedOrderLine): CreateOrderItemInput => ({
        region,
        productId: line.productId,
        quantity: line.quantity,
        unitPriceSnapshot: line.unitPriceMinor,
        nameSnapshot: line.nameSnapshot,
        imageUrlSnapshot: line.imageUrlSnapshot,
        lineTotal: line.lineTotal,
    });
}

/**
 * Recovers the offending lines from core's `reserve-stock` 409 so the failure
 * can be re-thrown in this module's own contract shape.
 *
 * `coreUpstreamError` parks core's parsed body on `details.upstream`, and core
 * wraps every reply as `{success, data}` with `AppError.details` merged into
 * `data` — so the lines land at `upstream.data.details`. Returns undefined for
 * anything that isn't recognisably that shape, which is the signal to rethrow
 * the original error untouched rather than mislabel it as a stock problem.
 */
function outOfStockLinesFromCoreError(err: unknown): OutOfStockLine[] | undefined {
    if (!(err instanceof AppError) || err.statusCode !== 409) return undefined;

    const data = (err.details?.upstream as {data?: {message?: string; details?: unknown}} | undefined)?.data;
    if (data?.message !== "OutOfStock" || !Array.isArray(data.details)) return undefined;

    const lines = data.details.filter(
        (line): line is OutOfStockLine =>
            typeof line === "object" &&
            line !== null &&
            typeof (line as OutOfStockLine).productId === "number",
    );
    return lines.length > 0 ? lines : undefined;
}

/**
 * Partition window for a public-id lookup, recovered from the UUIDv7
 * timestamp. Returns undefined for a non-v7 id, which means "scan every
 * partition" — correct, just slower, and the only way an id minted before this
 * service moved to v7 stays readable.
 */
function publicIdWindow(publicId: string): CreatedAtWindow | undefined {
    const minted = timestampFromUuidV7(publicId);
    if (!minted) return undefined;

    return {
        from: new Date(minted.getTime() - PUBLIC_ID_WINDOW_MS),
        to: new Date(minted.getTime() + PUBLIC_ID_WINDOW_MS),
    };
}

/** Local-time year bounds, matching how `created_at` is stored. */
function yearWindow(year: number): CreatedAtWindow {
    return {from: new Date(year, 0, 1), to: new Date(year + 1, 0, 1)};
}

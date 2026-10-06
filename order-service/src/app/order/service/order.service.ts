import {container, inject, injectable} from "tsyringe";
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
import {getBranch, releaseStock, reserveStock} from "../../../lib/core-client/branch.client";
import {getBranchProducts} from "../../../lib/core-client/product.client";
import {getCustomerAddress} from "../../../lib/core-client/address.client";
import {branchRejectingOrdersKey} from "../../../lib/core-client/cache-keys";
import {CoreCallContext, ReserveStockItem} from "../../../lib/core-client/types";
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
import {SERVICE_FEE_MINOR} from "../constants";
import {CreateOrderRequestDTO} from "../dto/order.request.dto";
import {
    OrderDetailResponseDTO,
    OrderResponseDTO,
    OrderStatusResponseDTO,
    OrderSummaryResponseDTO,
    PaymentHandoffDTO,
} from "../dto/order.response.dto";
import {OrderStatusService} from "./order-status.service";
// Type-only: the payment module imports this one, and a value import here
// would close the cycle at require() time. The instance is resolved from the
// container at call time instead (see `payments`).
import type {PaymentService} from "../../payment/service/payment.service";

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

/** `status_reason` on an order the payment-expiry sweep cancels. */
const PAYMENT_EXPIRED_REASON = "payment_session_expired";

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
     * transaction.
     *
     * Stock is reserved in core *before* that transaction opens. Core's
     * decrement is a separate database that cannot join our transaction, so
     * one of the two has to go first and the loser needs a compensation:
     *
     *  - Reserve first (this): a failure to write the order leaves units held
     *    that nobody owns, and we hand them back with `releaseStock`. The
     *    customer sees either a placed order or an error — never a placed
     *    order the kitchen cannot fill.
     *  - Commit first: a failed reserve leaves a *placed* order with no stock
     *    behind it, which can only be compensated by cancelling an order the
     *    customer has already been told about, and which the restaurant may
     *    have already seen on its dashboard.
     *
     * The second failure is worse, and it is also the likelier one — losing a
     * race for the last unit is ordinary, whereas failing our own single-shard
     * insert is not. Reserving first also costs nothing in lock time: the HTTP
     * round trip happens before our transaction opens rather than inside it.
     *
     * The compensation is not transactional, so it must run at most once per
     * reserve (core has no reservations ledger to match it against). Strict
     * idempotency on this endpoint is what guarantees that — a replayed
     * `POST /orders` is answered from the recorded response and never reaches
     * this method.
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
        const serviceFee = SERVICE_FEE_MINOR;
        const total = subtotal + deliveryFee + serviceFee;

        const isOnline = input.paymentMethod === PaymentMethod.ONLINE;
        const publicId = newPublicId();
        const conn = db(region);

        // COD is in the restaurant's queue immediately; an online order isn't
        // placed until Kashier confirms the capture (Phase 2).
        const status = isOnline ? OrderStatus.PENDING_PAYMENT : OrderStatus.PLACED;

        // Held before anything is written, so the order rows below are only
        // ever created for units we already own.
        const reserved = [...lineByProduct].map(([productId, quantity]) => ({productId, quantity}));
        await this.reserveStockOrFail(branch.id, reserved, ctx);

        let order: OrderEntity;
        let items: OrderItemEntity[];
        try {
            const trx = await conn.transaction();
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
        } catch (err) {
            // The units are held and no order claims them. Hand them back
            // before surfacing the failure — the customer's retry will reserve
            // them again, and nothing else will ever come looking for them.
            //
            // The outer try also covers `conn.transaction()` itself, which is
            // where a shard that has gone away fails: that is exactly the case
            // where units would otherwise leak until a stock audit.
            await this.releaseReservedStock(branch.id, reserved, ctx);
            throw err;
        }

        // Online orders stay invisible to the kitchen until payment lands.
        if (!isOnline) {
            this.publishCreated(order, items.length);
            await this.invalidateBranchOrderLists(order.branchId);
            return OrderResponseDTO.from(order, items);
        }

        return OrderResponseDTO.from(order, items, await this.openPaymentSession(order, ctx));
    };

    /**
     * Opens the checkout session for an online order and hands the client the
     * redirect, so placing and paying is one round trip.
     *
     * Best-effort by design. The order is already committed and its stock is
     * already held; failing the whole placement because the acquirer was slow
     * would throw away work the customer has done and leave us compensating
     * a transaction that actually succeeded. A null `payment` block means
     * exactly one thing to the client — call `POST /api/payments/init` — and
     * if nobody ever does, the expiry sweep gives the stock back.
     *
     * The payment service is resolved from the container here rather than
     * injected, because it injects *this* service: the webhook settles an
     * order and the sweep cancels one, so the dependency genuinely runs both
     * ways. Resolving the back-edge at call time is what keeps that from
     * being a constructor cycle, and it is the same pattern the core-event
     * handlers use (CLAUDE.md s8/Handler structure).
     */
    private openPaymentSession = async (
        order: OrderEntity,
        ctx: PlaceOrderContext,
    ): Promise<PaymentHandoffDTO | undefined> => {
        try {
            const session = await this.payments().openSessionFor(order, {
                region: ctx.region,
                correlationId: ctx.correlationId,
            });
            return {sessionId: session.providerSessionId, redirectUrl: session.redirectUrl};
        } catch (err) {
            logger.error("order placed but payment session could not be opened", {
                orderPublicId: order.publicId,
                correlationId: ctx.correlationId,
                error: (err as Error).message,
            });
            return undefined;
        }
    };

    private payments = (): PaymentService =>
        container.resolve<PaymentService>(TOKENS.PaymentService);

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
        const paymentSummary = await this.payments().summarizeForOrder(order, conn);
        return OrderDetailResponseDTO.fromDetail(order, items, paymentSummary);
    };

    /**
     * The order behind a public id, with no authorisation check — for callers
     * that have already established their own right to it, or that have no
     * HTTP caller at all (the payment webhook, the expiry sweep). Takes the
     * connection so it can join a transaction the caller owns.
     *
     * Name is caller-agnostic on purpose (CLAUDE.md s8): a `findByPublicId`
     * is a `findByPublicId` whoever asks. The authorisation lives in
     * `getOrder` and in `assertCanRead`, which callers that need it invoke
     * explicitly rather than getting silently.
     */
    findByPublicId = async (publicId: string, conn: Knex): Promise<OrderEntity> => {
        const order = await findOrderByPublicId(publicId, conn, publicIdWindow(publicId));
        if (!order) throw OrderNotFoundError;
        return order;
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
     * A transition no human requested: the payment webhook placing an order
     * once the capture lands, the expiry sweep cancelling one that was never
     * paid, the assignment service moving one to `assigned` (Phase 3).
     *
     * Takes the caller's transaction, because the point of a system
     * transition is that it commits with whatever made it true — an order
     * that is `placed` with no charge row, or a charge row against an order
     * still waiting for payment, are both states nobody should be able to
     * observe.
     *
     * Still goes through the status machine with `OrderActor.SYSTEM`: being
     * the system is permission to traverse the system's edges, not licence to
     * invent one.
     */
    transitionBySystem = async (
        order: OrderEntity,
        target: OrderStatus,
        conn: Knex,
        reason?: string,
    ): Promise<OrderEntity> => {
        const timestampColumn = this.statusService.assertTransition(
            order.status,
            target,
            OrderActor.SYSTEM,
        );

        const updated = await updateOrderStatus(
            order.id,
            order.createdAt,
            order.status,
            {status: target, statusReason: reason ?? null, timestampColumn},
            conn,
        );
        // Zero rows means something else moved the order between the read and
        // the write. The caller's transaction must not commit on a stale
        // premise, so this is an error rather than a silent no-op.
        if (!updated) throw OrderNotFoundError;

        return updated;
    };

    /**
     * Cancels an online order whose payment never arrived, and gives the
     * stock back.
     *
     * The stock release is the part that matters. An online order holds units
     * core decremented before the order row existed, so an abandoned checkout
     * takes them out of circulation until something returns them — this is
     * that something. It runs after the cancellation commits, not inside it:
     * core is a different database and cannot join our transaction, and the
     * order of the two is chosen the same way placement chooses it, by which
     * failure is survivable. A cancelled order whose release failed leaks
     * stock and is logged loudly; a release that happened for an order that
     * then failed to cancel would hand out units an order still claims.
     */
    cancelUnpaidOrder = async (order: OrderEntity, conn: Knex): Promise<OrderEntity> => {
        const items = await findItemsByOrderIds([order.id], conn);
        const cancelled = await this.transitionBySystem(
            order,
            OrderStatus.CANCELLED,
            conn,
            PAYMENT_EXPIRED_REASON,
        );

        await this.releaseReservedStock(
            order.branchId,
            items.map((item) => ({productId: item.productId, quantity: item.quantity})),
            {},
        );

        await this.invalidateBranchOrderLists(cancelled.branchId);
        this.publishStatusChange(cancelled, PAYMENT_EXPIRED_REASON);
        return cancelled;
    };

    /**
     * Announces an order that has just become visible to the restaurant.
     *
     * Called by the payment module after a capture commits, and by
     * `placeOrder` for COD. Deliberately post-commit and deliberately
     * best-effort: a broadcast is a notification about something that has
     * already happened, and the transaction it describes is long since
     * durable.
     */
    announcePlacement = async (order: OrderEntity): Promise<void> => {
        const conn = db(order.region);
        const [count] = await countItemsByOrderIds([order.id], conn);

        this.publishCreated(order, count?.count ?? 0);
        this.publishStatusChange(order);
        await this.invalidateBranchOrderLists(order.branchId);
    };

    /**
     * The read rule, for other modules that hold an order and a caller and
     * need the same answer this module would give — `GET /api/payments/{id}`
     * authorises against the order behind the ledger row. Exposed rather than
     * restated there, because two copies of a tenancy check are two chances
     * to disagree.
     */
    assertCanRead = (order: OrderEntity, requester: OrderRequester): void =>
        this.assertCanReadOrder(order, requester);

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
     * Holds the units this order needs, before any of it is written.
     *
     * Core's locked decrement is the authority on who got the last unit; the
     * pre-check in `priceLines` against the cached product projection only
     * exists to fail fast with a good message, and can be stale by
     * construction. So a 409 here is an ordinary outcome, not an anomaly — and
     * it is translated back into this module's own contract shape
     * (docs/api-contracts.md s1.1) rather than surfacing core's envelope
     * stringified into a message. A customer who loses the race for the last
     * unit gets the same body as one who never had a chance at it.
     */
    private reserveStockOrFail = async (
        branchId: number,
        items: ReserveStockItem[],
        ctx: CoreCallContext,
    ): Promise<void> => {
        try {
            await reserveStock(branchId, items, ctx);
        } catch (err) {
            const lines = outOfStockLinesFromCoreError(err);
            if (lines) throw outOfStockError(lines);
            throw err;
        }
    };

    /**
     * Gives back units a reserve is holding for an order that was never
     * written.
     *
     * Deliberately swallows its own failure and logs instead: the caller is
     * already throwing the error the customer will see, and replacing it with
     * "the release failed" would tell them nothing they can act on while
     * hiding why their order didn't happen.
     *
     * Both failure branches are logged at `error` because both leak stock —
     * units marked sold that nobody bought. That is an operator problem, not a
     * customer one: it shows up as a branch that has quietly stopped selling a
     * product. `missing` lines are core telling us the product row is gone, so
     * the units had nowhere to return to.
     */
    private releaseReservedStock = async (
        branchId: number,
        items: ReserveStockItem[],
        ctx: CoreCallContext,
    ): Promise<void> => {
        try {
            const result = await releaseStock(branchId, items, ctx);
            if (result.missing.length > 0) {
                logger.error("stock release could not return every line", {
                    branchId,
                    missing: result.missing,
                });
            }
        } catch (err) {
            logger.error("failed to release reserved stock after a failed placement", {
                branchId,
                items,
                correlationId: ctx.correlationId,
                error: (err as Error).message,
            });
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
     * The `order.created` broadcast — the moment an order becomes visible to
     * the restaurant. For COD that is placement; for an online order it is
     * the capture, which is why the payment module calls
     * `announcePlacement` rather than inlining its own emit.
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

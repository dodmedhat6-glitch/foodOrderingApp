import {container, inject, injectable} from "tsyringe";
import {AppError} from "../../../lib/error/AppError";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {TOKENS} from "../../../lib/di/tokens";
import {logger} from "../../../lib/logger/logger";
import {db} from "../../../lib/knex/knex";
import {isRegion} from "../../../lib/sharding/regions";
import {newPublicId} from "../../../pkg/utils/uuid";
import {getBranch} from "../../../lib/core-client/branch.client";
import {getBranchProducts} from "../../../lib/core-client/product.client";
import {getCustomerAddress} from "../../../lib/core-client/address.client";
import {branchRejectingOrdersKey} from "../../../lib/core-client/cache-keys";
import {CoreCallContext} from "../../../lib/core-client/types";
import {OrderEntity} from "../entity/order.entity";
import {OrderItemEntity} from "../entity/order-item.entity";
import {OrderStatus, PaymentMethod} from "../enums";
import {
    AddressNotOwnedError,
    BranchNotAcceptingOrdersError,
    DuplicateProductInOrderError,
    OutOfStockLine,
    outOfStockError,
} from "../errors";
import {createOrder} from "../repository/order.repo";
import {bulkInsertItems} from "../repository/order-item.repo";
import {CreateOrderItemInput, OrderRequester, PlaceOrderContext, PricedOrderLine} from "../types";
import {SERVICE_FEE_MINOR} from "../constants";
import {CreateOrderRequestDTO} from "../dto/order.request.dto";
import {OrderResponseDTO, PaymentHandoffDTO} from "../dto/order.response.dto";
import {releaseReservedStock, reserveStockOrFail} from "../stock";
import {OrderNotifier} from "./order-notifier.service";
import {enqueueOrderPlaced} from "../events";
// Type-only: the payment module imports the order module, and a value import
// here would close the cycle at require() time. The instance is resolved from
// the container at call time instead (see `payments`).
import type {PaymentService} from "../../payment/service/payment.service";

/**
 * Placing an order (docs/business-logic/orders.md s2): validate against
 * core, price the basket, hold the stock, write the order, and — for an
 * online order — open the checkout session.
 */
@injectable()
export class OrderPlacementService {
    constructor(
        @inject(TOKENS.OrderNotifier) private readonly notifier: OrderNotifier,
        @inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider,
    ) {}

    /**
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
        await reserveStockOrFail(branch.id, reserved, ctx);

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

                // Same trx as the order: the event exists iff the order does.
                // Online orders are `pending_payment` here and emit theirs
                // when the capture moves them to `placed` (see ../events.ts).
                if (order.status === OrderStatus.PLACED) {
                    await enqueueOrderPlaced(order, items, trx);
                }

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
            await releaseReservedStock(branch.id, reserved, ctx);
            throw err;
        }

        // Online orders stay invisible to the kitchen until payment lands.
        if (!isOnline) {
            await this.notifier.announceCreated(order, items.length);
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
     * injected, because it depends on the order module: the webhook settles an
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

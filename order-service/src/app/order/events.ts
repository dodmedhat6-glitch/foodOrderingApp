import {Knex} from "knex";
import {enqueueOutboxEvent} from "../../lib/events/outbox.repo";
import {ORDER_ENTITY_TYPE, OrderEventType} from "../../lib/events/event-types";
import {OrderPlacedPayload} from "../../lib/events/types";
import {OrderEntity} from "./entity/order.entity";
import {OrderItemEntity} from "./entity/order-item.entity";

/**
 * Enqueues `order.placed` for an order that has just become `placed`.
 *
 * There are exactly two ways in, and both call this inside the transaction
 * that makes the order `placed`:
 *
 *  - COD — `OrderPlacementService.placeOrder`, in the placement trx.
 *  - Online — `OrderService.transitionInTrx` to `placed`, in the payment
 *    webhook's trx. The `pending_payment` row written at checkout emits
 *    nothing: an order nobody paid for is not revenue to anyone downstream,
 *    and an abandoned one is cancelled by the expiry sweep without ever
 *    having been seen.
 *
 * `conn` must be that transaction — see `enqueueOutboxEvent`.
 */
export async function enqueueOrderPlaced(
    order: OrderEntity,
    items: OrderItemEntity[],
    conn: Knex,
): Promise<void> {
    await enqueueOutboxEvent(
        {
            eventType: OrderEventType.ORDER_PLACED,
            entityType: ORDER_ENTITY_TYPE,
            entityId: order.publicId,
            payload: toOrderPlacedPayload(order, items),
        },
        conn,
    );
}

function toOrderPlacedPayload(order: OrderEntity, items: OrderItemEntity[]): OrderPlacedPayload {
    return {
        orderId: order.publicId,
        region: order.region,
        countryCode: order.countryCode,
        restaurantId: order.restaurantId,
        branchId: order.branchId,
        customerId: order.customerId,
        status: order.status,
        paymentMethod: order.paymentMethod,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        total: order.total,
        currency: order.currency,
        items: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceSnapshot,
            lineTotal: item.lineTotal,
        })),
        // Always set on a `placed` row — both callers stamp it in the same
        // write. The fallback only guards a payload from ever carrying null.
        placedAt: new Date(order.placedAt ?? order.updatedAt).toISOString(),
    };
}

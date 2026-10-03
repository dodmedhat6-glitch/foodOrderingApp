import {OrderEntity} from "../entity/order.entity";
import {OrderItemEntity} from "../entity/order-item.entity";
import {OrderStatus, PaymentMethod} from "../enums";

/**
 * Wire shapes for every order response (CLAUDE.md s6). Nothing here is a
 * entity or a DB row: money stays integer minor units next to a currency,
 * timestamps are ISO-8601 UTC strings, and the internal bigserial id, the
 * region and the commission never cross the boundary.
 */

export class OrderItemResponseDTO {
    productId!: number;
    name!: string;
    imageUrl?: string;
    quantity!: number;
    unitPrice!: number;
    lineTotal!: number;

    static from(item: OrderItemEntity): OrderItemResponseDTO {
        const dto = new OrderItemResponseDTO();
        dto.productId = item.productId;
        dto.name = item.nameSnapshot;
        if (item.imageUrlSnapshot) dto.imageUrl = item.imageUrlSnapshot;
        dto.quantity = item.quantity;
        dto.unitPrice = item.unitPriceSnapshot;
        dto.lineTotal = item.lineTotal;
        return dto;
    }
}

export interface PaymentHandoffDTO {
    sessionId: string;
    redirectUrl: string;
}

export class OrderResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    paymentMethod!: PaymentMethod;
    branch!: {id: number; name: string};
    restaurant!: {id: number; name: string};
    customerAddress!: {lat: number; lng: number; addressText: string};
    subtotal!: number;
    deliveryFee!: number;
    serviceFee!: number;
    total!: number;
    currency!: string;
    items!: OrderItemResponseDTO[];
    createdAt!: string;
    /** Online orders only, and only once a payment session exists (Phase 2). */
    payment?: PaymentHandoffDTO;

    static from(
        order: OrderEntity,
        items: OrderItemEntity[],
        payment?: PaymentHandoffDTO,
    ): OrderResponseDTO {
        const dto = new OrderResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.paymentMethod = order.paymentMethod;
        dto.branch = {id: order.branchId, name: order.branchNameSnapshot};
        dto.restaurant = {id: order.restaurantId, name: order.restaurantNameSnapshot};
        dto.customerAddress = {
            lat: Number(order.deliveryLat),
            lng: Number(order.deliveryLng),
            addressText: order.deliveryAddressTextSnapshot,
        };
        dto.subtotal = order.subtotal;
        dto.deliveryFee = order.deliveryFee;
        dto.serviceFee = order.serviceFee;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.items = items.map(OrderItemResponseDTO.from);
        dto.createdAt = order.createdAt.toISOString();
        if (payment) dto.payment = payment;
        return dto;
    }
}

export class OrderSummaryResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    total!: number;
    currency!: string;
    itemsCount!: number;
    restaurant!: {id: number; name: string};
    branchId!: number;
    createdAt!: string;

    static from(order: OrderEntity, itemsCount: number): OrderSummaryResponseDTO {
        const dto = new OrderSummaryResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.itemsCount = itemsCount;
        dto.restaurant = {id: order.restaurantId, name: order.restaurantNameSnapshot};
        dto.branchId = order.branchId;
        dto.createdAt = order.createdAt.toISOString();
        return dto;
    }
}

export interface OrderPaymentSummaryDTO {
    method: PaymentMethod;
    status: "pending" | "authorized" | "captured" | "failed" | "refunded";
    amount: number;
    currency: string;
    refundedAmount: number;
}

export interface OrderHistoryEntryDTO {
    status: OrderStatus;
    ts: string;
}

export class OrderDetailResponseDTO extends OrderResponseDTO {
    paymentSummary!: OrderPaymentSummaryDTO;
    history!: OrderHistoryEntryDTO[];

    static fromDetail(
        order: OrderEntity,
        items: OrderItemEntity[],
        paymentSummary: OrderPaymentSummaryDTO,
        payment?: PaymentHandoffDTO,
    ): OrderDetailResponseDTO {
        const dto = Object.assign(
            new OrderDetailResponseDTO(),
            OrderResponseDTO.from(order, items, payment),
        );
        dto.paymentSummary = paymentSummary;
        dto.history = buildHistory(order);
        return dto;
    }
}

export class OrderStatusResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    updatedAt!: string;

    static from(order: OrderEntity): OrderStatusResponseDTO {
        const dto = new OrderStatusResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.updatedAt = order.updatedAt.toISOString();
        return dto;
    }
}

/**
 * The status timeline, reconstructed from the per-transition timestamp columns
 * rather than a separate history table — the columns already record every
 * transition the status machine allows, and an append-only order can only have
 * visited each status once.
 */
function buildHistory(order: OrderEntity): OrderHistoryEntryDTO[] {
    const stamped: Array<[OrderStatus, Date | null]> = [
        [OrderStatus.PENDING_PAYMENT, order.paymentMethod === PaymentMethod.ONLINE ? order.createdAt : null],
        [OrderStatus.PLACED, order.placedAt],
        [OrderStatus.ACCEPTED, order.acceptedAt],
        [OrderStatus.REJECTED, order.rejectedAt],
        [OrderStatus.PREPARING, order.preparingAt],
        [OrderStatus.READY, order.readyAt],
        [OrderStatus.ASSIGNED, order.assignedAt],
        [OrderStatus.PICKED, order.pickedAt],
        [OrderStatus.DELIVERED, order.deliveredAt],
        [OrderStatus.CANCELLED, order.cancelledAt],
    ];

    return stamped
        .filter((entry): entry is [OrderStatus, Date] => entry[1] !== null)
        .sort((a, b) => a[1].getTime() - b[1].getTime())
        .map(([status, ts]) => ({status, ts: ts.toISOString()}));
}

import {OrderStatus, PaymentMethod} from "./enums";

/**
 * Module-level helper shapes shared between the repo, service and controller.
 * Kept here so none of those files declare inline interfaces (CLAUDE.md s5.10).
 */

/** Everything the repo needs to insert one `orders` row. */
export interface CreateOrderInput {
    region: string;
    publicId: string;
    countryCode: string;
    restaurantId: number;
    branchId: number;
    customerId: number;
    customerAddressId: number;
    deliveryLat: number;
    deliveryLng: number;
    deliveryAddressTextSnapshot: string;
    branchNameSnapshot: string;
    restaurantNameSnapshot: string;
    status: OrderStatus;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: string;
    paymentMethod: PaymentMethod;
    placedAt: Date | null;
}

/** One `order_items` row, sans the order id the repo fills in. */
export interface CreateOrderItemInput {
    region: string;
    productId: number;
    quantity: number;
    unitPriceSnapshot: number;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    lineTotal: number;
}

export interface UpdateOrderStatusInput {
    status: OrderStatus;
    statusReason?: string | null;
    /** The `<verb>_at` column to stamp for this target status. */
    timestampColumn?: string;
}

export interface ListOrdersFilters {
    status?: OrderStatus;
    from?: Date;
    to?: Date;
}

export interface OrderItemCount {
    orderId: number;
    count: number;
}

/** Resolved, validated inputs for a placement — the service's working set. */
export interface PricedOrderLine {
    productId: number;
    quantity: number;
    unitPriceMinor: number;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    lineTotal: number;
}

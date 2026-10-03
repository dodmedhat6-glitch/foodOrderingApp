import {OrderStatus, PaymentMethod} from "../enums";

/**
 * The `orders` row. Plain class, constructed from `Partial` — no decorators,
 * no DB knowledge, no persistence methods (CLAUDE.md s5.1).
 *
 * Money fields are integer minor units throughout; `publicId` is the UUIDv7
 * clients see, while `id` is the internal bigserial that never leaves this
 * service.
 */
export class OrderEntity {
    id: number;
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
    statusReason: string | null;

    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    commission: number;
    currency: string;

    paymentMethod: PaymentMethod;
    deliveryAgentId: number | null;

    createdAt: Date;
    updatedAt: Date;
    placedAt: Date | null;
    acceptedAt: Date | null;
    rejectedAt: Date | null;
    preparingAt: Date | null;
    readyAt: Date | null;
    assignedAt: Date | null;
    pickedAt: Date | null;
    deliveredAt: Date | null;
    cancelledAt: Date | null;

    constructor(data: Partial<OrderEntity>) {
        this.id = data.id!;
        this.region = data.region!;
        this.publicId = data.publicId!;
        this.countryCode = data.countryCode!;
        this.restaurantId = data.restaurantId!;
        this.branchId = data.branchId!;
        this.customerId = data.customerId!;
        this.customerAddressId = data.customerAddressId!;

        this.deliveryLat = data.deliveryLat!;
        this.deliveryLng = data.deliveryLng!;
        this.deliveryAddressTextSnapshot = data.deliveryAddressTextSnapshot!;
        this.branchNameSnapshot = data.branchNameSnapshot!;
        this.restaurantNameSnapshot = data.restaurantNameSnapshot!;

        this.status = data.status!;
        this.statusReason = data.statusReason ?? null;

        this.subtotal = data.subtotal ?? 0;
        this.deliveryFee = data.deliveryFee ?? 0;
        this.serviceFee = data.serviceFee ?? 0;
        this.total = data.total ?? 0;
        this.commission = data.commission ?? 0;
        this.currency = data.currency!;

        this.paymentMethod = data.paymentMethod!;
        this.deliveryAgentId = data.deliveryAgentId ?? null;

        this.createdAt = data.createdAt ?? new Date();
        this.updatedAt = data.updatedAt ?? new Date();
        this.placedAt = data.placedAt ?? null;
        this.acceptedAt = data.acceptedAt ?? null;
        this.rejectedAt = data.rejectedAt ?? null;
        this.preparingAt = data.preparingAt ?? null;
        this.readyAt = data.readyAt ?? null;
        this.assignedAt = data.assignedAt ?? null;
        this.pickedAt = data.pickedAt ?? null;
        this.deliveredAt = data.deliveredAt ?? null;
        this.cancelledAt = data.cancelledAt ?? null;
    }

    /**
     * Whether the customer may still cancel: only before the restaurant has
     * accepted, and only inside the 60s grace window that starts when the
     * order was placed (docs/business-logic/orders.md s9).
     *
     * An online order sits in `pending_payment` with no `placed_at` until the
     * payment is captured; there is nothing for the restaurant to act on yet,
     * so the window is open for as long as that status lasts (the 15-minute
     * payment sweep is what ends it).
     */
    isWithinCustomerCancellationWindow(windowMs: number, now: Date = new Date()): boolean {
        if (this.acceptedAt) return false;
        if (this.status === OrderStatus.PENDING_PAYMENT) return true;
        if (!this.placedAt) return false;
        return now.getTime() - this.placedAt.getTime() <= windowMs;
    }
}

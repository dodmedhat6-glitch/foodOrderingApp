import {OPEN_SESSION_STATUSES, PaymentSessionStatus} from "../enums";

/**
 * A `payment_sessions` row — our mirror of one checkout attempt at the
 * provider. Plain class built from `Partial`, no decorators, no DB knowledge
 * (CLAUDE.md s5.1).
 *
 * `amount` is minor units. `merchantOrderRef` is the reference we gave the
 * provider and the handle its webhooks come back on; `providerOrderId` is the
 * provider's own order id, which we only learn once a webhook lands.
 */
export class PaymentSessionEntity {
    id: number;
    region: string;
    orderId: number;
    orderPublicId: string;
    providerId: number;
    merchantOrderRef: string;
    providerSessionId: string;
    providerOrderId: string | null;
    redirectUrl: string;
    amount: number;
    currency: string;
    status: PaymentSessionStatus;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;

    constructor(data: Partial<PaymentSessionEntity>) {
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId!;
        this.orderPublicId = data.orderPublicId!;
        this.providerId = data.providerId!;
        this.merchantOrderRef = data.merchantOrderRef!;
        this.providerSessionId = data.providerSessionId!;
        this.providerOrderId = data.providerOrderId ?? null;
        this.redirectUrl = data.redirectUrl!;
        this.amount = data.amount ?? 0;
        this.currency = data.currency!;
        this.status = data.status!;
        this.expiresAt = data.expiresAt!;
        this.createdAt = data.createdAt ?? new Date();
        this.updatedAt = data.updatedAt ?? new Date();
    }

    /**
     * Whether the customer could still pay on this session, which is what
     * makes `POST /payments/init` return it again instead of creating a
     * second one. Expiry is checked against the clock as well as the status
     * because the sweep that writes `expired` runs on an interval, and a
     * session that has passed `expiresAt` is unpayable whether or not the
     * sweep has caught up with it.
     */
    isOpen(now: Date = new Date()): boolean {
        return (
            OPEN_SESSION_STATUSES.includes(this.status) && this.expiresAt.getTime() > now.getTime()
        );
    }

    isSettled(): boolean {
        return this.status === PaymentSessionStatus.CAPTURED;
    }
}

import {TransactionMethod, TransactionStatus, TransactionType} from "../enums";

/**
 * A `transactions` row — one movement of money.
 *
 * `amount` is always positive minor units; which way it went is read from
 * `(type, srcAccId, dstAccId)`, where a null account means the platform. A
 * charge is customer -> platform, a refund is platform -> customer, a
 * commission is restaurant owner -> platform, a payout is platform -> owner.
 */
export class TransactionEntity {
    id: number;
    region: string;
    orderId: number | null;
    orderPublicId: string | null;
    type: TransactionType;
    method: TransactionMethod;
    providerId: number | null;
    providerReferenceId: string | null;
    status: TransactionStatus;
    amount: number;
    currency: string;
    srcAccId: number | null;
    dstAccId: number | null;
    isRefunded: boolean;
    refundedPaymentId: number | null;
    idempotencyKey: string | null;
    createdAt: Date;
    updatedAt: Date;

    constructor(data: Partial<TransactionEntity>) {
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId ?? null;
        this.orderPublicId = data.orderPublicId ?? null;
        this.type = data.type!;
        this.method = data.method!;
        this.providerId = data.providerId ?? null;
        this.providerReferenceId = data.providerReferenceId ?? null;
        this.status = data.status!;
        this.amount = data.amount ?? 0;
        this.currency = data.currency!;
        this.srcAccId = data.srcAccId ?? null;
        this.dstAccId = data.dstAccId ?? null;
        this.isRefunded = data.isRefunded ?? false;
        this.refundedPaymentId = data.refundedPaymentId ?? null;
        this.idempotencyKey = data.idempotencyKey ?? null;
        this.createdAt = data.createdAt ?? new Date();
        this.updatedAt = data.updatedAt ?? new Date();
    }

    /** A settled customer payment — the only kind of row a refund may target. */
    isRefundableCharge(): boolean {
        return (
            (this.type === TransactionType.CHARGE ||
                this.type === TransactionType.COD_COLLECTION) &&
            this.status === TransactionStatus.SUCCEEDED
        );
    }
}

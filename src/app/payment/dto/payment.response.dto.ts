import {PaymentSessionEntity} from "../entity/payment-session.entity";
import {TransactionEntity} from "../entity/transaction.entity";
import {
    PaymentProviderName,
    PaymentSessionStatus,
    TransactionMethod,
    TransactionStatus,
    TransactionType,
} from "../enums";

/**
 * Every payment response is shaped here (CLAUDE.md s6). Money stays integer
 * minor units next to its currency, timestamps are ISO 8601 UTC, and nothing
 * internal crosses the wire: no bigserial order id, no `raw_init_payload`, no
 * secret, and no provider session id beyond the one the client needs in order
 * to be redirected.
 */

export class PaymentInitResponseDTO {
    sessionId!: number;
    providerSessionId!: string;
    redirectUrl!: string;
    expiresAt!: string;
    amount!: number;
    currency!: string;
    status!: PaymentSessionStatus;

    static from(session: PaymentSessionEntity): PaymentInitResponseDTO {
        const dto = new PaymentInitResponseDTO();
        dto.sessionId = session.id;
        dto.providerSessionId = session.providerSessionId;
        dto.redirectUrl = session.redirectUrl;
        dto.expiresAt = session.expiresAt.toISOString();
        dto.amount = session.amount;
        dto.currency = session.currency;
        dto.status = session.status;
        return dto;
    }
}

/**
 * One ledger row, as `GET /api/payments/{paymentId}` returns it.
 *
 * `providerReferenceId` is included deliberately — it is the id a support
 * agent quotes to Kashier, and it is already visible to the customer on their
 * card statement, so it is not a secret. The provider's *numeric* id is not:
 * it means nothing outside this database, so the DTO carries the name.
 */
export class PaymentResponseDTO {
    id!: number;
    orderId!: string | null;
    type!: TransactionType;
    method!: TransactionMethod;
    provider!: PaymentProviderName | null;
    providerReferenceId!: string | null;
    status!: TransactionStatus;
    amount!: number;
    currency!: string;
    isRefunded!: boolean;
    refundedPaymentId!: number | null;
    createdAt!: string;
    updatedAt!: string;

    static from(
        transaction: TransactionEntity,
        providerName: PaymentProviderName | null,
    ): PaymentResponseDTO {
        const dto = new PaymentResponseDTO();
        dto.id = transaction.id;
        dto.orderId = transaction.orderPublicId;
        dto.type = transaction.type;
        dto.method = transaction.method;
        dto.provider = providerName;
        dto.providerReferenceId = transaction.providerReferenceId;
        dto.status = transaction.status;
        dto.amount = transaction.amount;
        dto.currency = transaction.currency;
        dto.isRefunded = transaction.isRefunded;
        dto.refundedPaymentId = transaction.refundedPaymentId;
        dto.createdAt = transaction.createdAt.toISOString();
        dto.updatedAt = transaction.updatedAt.toISOString();
        return dto;
    }
}

/**
 * `POST /api/payments/{paymentId}/refund` — 202, not 200. The refund row
 * exists and Kashier has accepted it, but the money has not moved yet; the
 * webhook is what flips it to `succeeded`. Reporting `succeeded` here would
 * be claiming an outcome the provider has not given us.
 */
export class RefundAcceptedResponseDTO {
    refundId!: number;
    status!: TransactionStatus;
    amount!: number;
    currency!: string;

    static from(refund: TransactionEntity): RefundAcceptedResponseDTO {
        const dto = new RefundAcceptedResponseDTO();
        dto.refundId = refund.id;
        dto.status = refund.status;
        dto.amount = refund.amount;
        dto.currency = refund.currency;
        return dto;
    }
}

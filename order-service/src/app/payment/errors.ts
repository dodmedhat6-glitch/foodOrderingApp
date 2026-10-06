import {AppError} from "../../lib/error/AppError";
import {PaymentProviderError} from "../../pkg/payments/payment.interface";

/**
 * Canonical payment errors (docs/api-contracts.md s2). Instances, not classes:
 * the wording and the status code are part of the contract, so a call site
 * can't drift from them.
 */

export const PaymentNotFoundError = new AppError("PaymentNotFound", 404);

export const OrderNotPendingPaymentError = new AppError("OrderNotPendingPayment", 409);

export const OrderNotOnlinePaymentError = new AppError("OrderNotOnlinePayment", 409);

export const PaymentProviderUnavailableError = new AppError("Payment provider unavailable", 503);

export const UnknownPaymentProviderError = new AppError("UnknownPaymentProvider", 404);

export const InvalidWebhookSignatureError = new AppError("InvalidSignature", 401);

export const NotARefundableChargeError = new AppError("NotARefundableCharge", 409);

export const RefundExceedsChargeError = new AppError("RefundExceedsCharge", 409);

export const RefundNotSupportedForMethodError = new AppError("RefundNotSupportedForMethod", 409);

/**
 * Turns a provider-layer failure into this module's contract.
 *
 * The split that matters is retryable vs not. `unavailable` means we never
 * got an answer, so the caller may try again and the order stays
 * `pending_payment` — 503. `rejected` means Kashier understood us and said
 * no; retrying sends the same request to the same answer, so it is a 502 with
 * the provider's own message attached for whoever reads the logs. A
 * `malformed` reply is the same class of problem: the provider is not
 * behaving as documented and nobody downstream can fix it by retrying.
 *
 * The provider's message is carried in `details.provider`, never in the
 * user-facing message — it is operator information, and its wording is
 * Kashier's to change.
 */
export function fromProviderError(err: unknown): AppError {
    if (!(err instanceof PaymentProviderError)) {
        return err instanceof AppError ? err : PaymentProviderUnavailableError;
    }

    if (err.kind === "unavailable") return PaymentProviderUnavailableError;

    return new AppError("PaymentProviderRejected", 502, true, {
        provider: err.provider,
        providerStatus: err.statusCode,
        providerMessage: err.message,
    });
}

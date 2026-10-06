import {inject, injectable} from "tsyringe";
import {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens";
import {logger} from "../../../lib/logger/logger";
import {db} from "../../../lib/knex/knex";
import {isRegion} from "../../../lib/sharding/regions";
import {wsChannels, wsPublish} from "../../../lib/websocket/publisher";
import {IPaymentProvider, ProviderWebhookEvent} from "../../../pkg/payments/payment.interface";
import {OrderEntity} from "../../order/entity/order.entity";
import {OrderStatus} from "../../order/enums";
import {OrderService} from "../../order/service/order.service";
import {PaymentSessionEntity} from "../entity/payment-session.entity";
import {TransactionEntity} from "../entity/transaction.entity";
import {
    PaymentSessionStatus,
    PaymentWsEvent,
    TransactionMethod,
    TransactionStatus,
    TransactionType,
} from "../enums";
import {InvalidWebhookSignatureError, UnknownPaymentProviderError} from "../errors";
import {parseMerchantOrderRef} from "../merchant-ref";
import {
    findWebhookEvent,
    markWebhookEventFailed,
    markWebhookEventProcessed,
    recordWebhookEvent,
} from "../repository/payment-webhook-event.repo";
import {
    findSessionByMerchantOrderRef,
    updateSession,
} from "../repository/payment-session.repo";
import {
    createTransactionIfNew,
    findPendingRefundToSettle,
    findTransactionById,
    markChargeFullyRefunded,
    sumRefundedAmount,
    updateTransactionStatus,
} from "../repository/transaction.repo";
import {CreateTransactionInput, MerchantOrderRef, WebhookProcessingResult} from "../types";
import {PaymentService} from "./payment.service";

/**
 * Settles provider webhooks (docs/business-logic/payments.md s3).
 *
 * Named for what it does rather than for Kashier, because nothing in it is
 * Kashier-specific: the signature check, the payload parsing and the event
 * vocabulary all live behind `IPaymentProvider` in `pkg/payments/`. Adding a
 * second acquirer means a second adapter, not a second copy of this.
 *
 * Three properties hold on every path, because an at-least-once provider
 * sending money events gives you nothing for free:
 *
 *  1. **Nothing is believed without the HMAC.** The endpoint is public and
 *     unauthenticated by design; the signature is the only thing standing
 *     between it and anyone who can guess an order reference.
 *  2. **Every event leaves a row.** `payment_webhook_events` is written
 *     before the money work and stamped with `processed_at` or
 *     `process_error` afterwards, on its own connection, so a failure is a
 *     record an operator can find rather than a lost log line
 *     (CLAUDE.md s10).
 *  3. **Replays are inert.** Three independent guards, deepest last: the
 *     unique `(provider_id, provider_event_id)`, the `FOR UPDATE` on the
 *     session that serialises concurrent deliveries, and the unique
 *     `transactions.idempotency_key` that makes a double credit impossible
 *     even if the first two were bypassed.
 */
@injectable()
export class PaymentWebhookService {
    constructor(
        @inject(TOKENS.PaymentProvider) private readonly provider: IPaymentProvider,
        @inject(TOKENS.PaymentService) private readonly paymentService: PaymentService,
        @inject(TOKENS.OrderService) private readonly orderService: OrderService,
    ) {}

    /**
     * Verifies, records and settles one inbound event.
     *
     * Returns rather than throws for everything the provider cannot fix by
     * resending — a duplicate, a reference that isn't ours, an amount that
     * doesn't match the session. Those become a 200 with the reason logged,
     * because a non-2xx here only buys the same event again on a backoff
     * schedule that runs for a day. It throws for genuine processing
     * failures, where a retry is exactly what we want.
     */
    handle = async (
        providerName: string,
        body: unknown,
        signature: string | undefined,
    ): Promise<WebhookProcessingResult> => {
        if (providerName !== this.provider.name) throw UnknownPaymentProviderError;
        if (!this.provider.verifyWebhook(body, signature)) throw InvalidWebhookSignatureError;

        const event = this.provider.parseWebhook(body);

        const ref = parseMerchantOrderRef(event.merchantOrderRef);
        if (!ref || !isRegion(ref.region)) {
            // Signed by our provider, but naming a payment we did not create
            // — a reference from another integration on the same merchant
            // account, or one from a region this process doesn't serve.
            // Nothing to do, and nothing a retry would change.
            logger.error("payment webhook: unrecognised merchant order reference", {
                merchantOrderRef: event.merchantOrderRef,
                eventType: event.eventType,
            });
            return {processed: false, reason: "UnrecognisedMerchantOrderRef"};
        }

        const conn = db(ref.region);
        const providerId = await this.paymentService.providerIdOf(
            this.provider.name,
            ref.region,
            conn,
        );

        const eventRowId = await this.recordArrival(
            event,
            ref.region,
            providerId,
            signature ?? "",
            body,
            conn,
        );
        if (eventRowId === undefined) return {processed: false, reason: "DuplicateEvent"};

        // Side effects that must not run until the money work has committed:
        // a socket message about a payment that then rolled back is a lie we
        // cannot retract.
        const afterCommit: Array<() => void> = [];

        const trx = await conn.transaction();
        try {
            const result = await this.dispatch(event, ref, afterCommit, trx);
            if (result) {
                // A refusal, not a failure. Roll back whatever the dispatch
                // touched, stamp why, and acknowledge — the provider resending
                // it would reach the same conclusion.
                await trx.rollback();
                await markWebhookEventFailed(eventRowId, result.reason ?? "refused", conn);
                return result;
            }

            await markWebhookEventProcessed(eventRowId, trx);
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            // Separate connection on purpose: the transaction that would have
            // carried this write is the one that just rolled back.
            await markWebhookEventFailed(eventRowId, (err as Error).message, conn).catch(() => {});
            throw err;
        }

        for (const effect of afterCommit) effect();
        return {processed: true};
    };

    /**
     * Writes the arrival record, returning its id when the event is new.
     *
     * A conflict is not automatically a duplicate: an event that arrived and
     * then failed mid-processing left a row with `processed_at IS NULL`, and
     * the provider's retry of *that* must be allowed through — which is the
     * entire reason the provider retries at all.
     */
    private recordArrival = async (
        event: ProviderWebhookEvent,
        region: string,
        providerId: number,
        signature: string,
        body: unknown,
        conn: Knex,
    ): Promise<number | undefined> => {
        const inserted = await recordWebhookEvent(
            {
                region,
                providerId,
                providerEventId: event.eventId,
                eventType: event.eventType,
                signature,
                payload: body,
            },
            conn,
        );
        if (inserted !== undefined) return inserted;

        const existing = await findWebhookEvent(providerId, event.eventId, conn);
        if (!existing || existing.processedAt) return undefined;
        return existing.id;
    };

    /**
     * Routes a verified event to the handler for its kind. Returns a result
     * only when the event is being *refused*; `undefined` means it settled.
     */
    private dispatch = async (
        event: ProviderWebhookEvent,
        ref: MerchantOrderRef,
        afterCommit: Array<() => void>,
        trx: Knex.Transaction,
    ): Promise<WebhookProcessingResult | undefined> => {
        switch (event.kind) {
            case "payment":
                return this.settlePayment(event, ref, afterCommit, trx);
            case "refund":
                return this.settleRefund(event, ref, afterCommit, trx);
            default:
                // `void`, `reversal`, `reject` and anything new Kashier starts
                // sending. Acknowledged and logged rather than dead-lettered:
                // the row in payment_webhook_events is the record, and a
                // handler written against an event we have never seen in
                // production would be a guess.
                logger.info("payment webhook: no handler for event kind", {
                    eventType: event.eventType,
                    kind: event.kind,
                    merchantOrderRef: event.merchantOrderRef,
                });
                return undefined;
        }
    };

    /**
     * A payment attempt reporting its outcome.
     *
     * The outcome comes from the provider's transaction status, never from
     * the event name — Kashier sends `pay` for a declined card too, and
     * reading the arrival of a `pay` as a payment is the mistake its own docs
     * warn about twice.
     */
    private settlePayment = async (
        event: ProviderWebhookEvent,
        ref: MerchantOrderRef,
        afterCommit: Array<() => void>,
        trx: Knex.Transaction,
    ): Promise<WebhookProcessingResult | undefined> => {
        const session = await findSessionByMerchantOrderRef(event.merchantOrderRef, trx, true);
        if (!session) {
            logger.error("payment webhook: no session for merchant order reference", {
                merchantOrderRef: event.merchantOrderRef,
            });
            return {processed: false, reason: "SessionNotFound"};
        }

        if (event.outcome === "pending") {
            await updateSession(
                session.id,
                {status: PaymentSessionStatus.PENDING, rawLastPayload: event},
                trx,
            );
            return undefined;
        }

        if (event.outcome === "failed") {
            return this.settleFailedPayment(event, session, afterCommit, trx);
        }

        if (session.isSettled()) return {processed: false, reason: "AlreadyCaptured"};

        // The amount is one of the signed fields, so a mismatch is not
        // tampering — it is the provider having captured something other than
        // what we asked for. Refusing is the only safe answer: crediting the
        // order would accept an amount nobody authorised, and retrying would
        // reach the same mismatch forever.
        if (event.amountMinor !== session.amount) {
            logger.error("payment webhook: captured amount does not match session", {
                merchantOrderRef: event.merchantOrderRef,
                sessionAmount: session.amount,
                eventAmount: event.amountMinor,
            });
            return {processed: false, reason: "AmountMismatch"};
        }

        const order = await this.orderService.findByPublicId(ref.orderPublicId, trx);

        await updateSession(
            session.id,
            {
                status: PaymentSessionStatus.CAPTURED,
                providerOrderId: event.providerOrderId,
                rawLastPayload: event,
            },
            trx,
        );

        const charge = await this.recordLedgerRow(
            {
                region: session.region,
                orderId: session.orderId,
                orderPublicId: session.orderPublicId,
                type: TransactionType.CHARGE,
                method: TransactionMethod.ONLINE,
                providerId: session.providerId,
                providerReferenceId: event.providerTransactionId,
                status: TransactionStatus.SUCCEEDED,
                amount: session.amount,
                currency: session.currency,
                // Customer -> platform. The restaurant is paid out of
                // the platform's balance on delivery (Phase 3), not here.
                srcAccId: order.customerId,
                dstAccId: null,
                idempotencyKey: this.ledgerKey(event),
            },
            trx,
        );
        if (!charge) return {processed: false, reason: "ChargeAlreadyRecorded"};

        // The order only becomes real to the kitchen now. A capture arriving
        // for an order that has moved on (cancelled by the expiry sweep while
        // the customer was paying) leaves the ledger row — the money did
        // move — and is reported so an operator can refund it.
        if (order.status !== OrderStatus.PENDING_PAYMENT) {
            logger.error("payment webhook: capture for an order no longer awaiting payment", {
                orderPublicId: order.publicId,
                status: order.status,
                paymentId: charge.id,
            });
            return undefined;
        }

        const placed = await this.orderService.transitionBySystem(order, OrderStatus.PLACED, trx);

        afterCommit.push(() => {
            wsPublish([wsChannels.customer(order.customerId)], PaymentWsEvent.CAPTURED, {
                orderId: order.publicId,
                paymentId: charge.id,
                amount: charge.amount,
                currency: charge.currency,
                ts: new Date().toISOString(),
            });
            void this.orderService.announcePlacement(placed);
        });

        return undefined;
    };

    private settleFailedPayment = async (
        event: ProviderWebhookEvent,
        session: PaymentSessionEntity,
        afterCommit: Array<() => void>,
        trx: Knex.Transaction,
    ): Promise<WebhookProcessingResult | undefined> => {
        await updateSession(
            session.id,
            {status: PaymentSessionStatus.FAILED, rawLastPayload: event},
            trx,
        );

        // Recorded as a ledger row even though no money moved: a declined
        // attempt is part of the audit trail for the order, and it is what a
        // support agent looks at when a customer says their card was charged.
        await this.recordLedgerRow(
            {
                region: session.region,
                orderId: session.orderId,
                orderPublicId: session.orderPublicId,
                type: TransactionType.CHARGE,
                method: TransactionMethod.ONLINE,
                providerId: session.providerId,
                providerReferenceId: event.providerTransactionId,
                status: TransactionStatus.FAILED,
                amount: session.amount,
                currency: session.currency,
                srcAccId: null,
                dstAccId: null,
                idempotencyKey: this.ledgerKey(event),
            },
            trx,
        );

        // The order stays `pending_payment` and the customer may try again
        // against a fresh session — the failure is theirs to retry, not ours
        // to cancel on their behalf.
        const customerId = (await this.orderService.findByPublicId(session.orderPublicId, trx))
            .customerId;

        afterCommit.push(() => {
            wsPublish([wsChannels.customer(customerId)], PaymentWsEvent.FAILED, {
                orderId: session.orderPublicId,
                reason: event.responseMessage ?? event.responseCode ?? "payment failed",
                ts: new Date().toISOString(),
            });
        });

        return undefined;
    };

    /** A refund we asked for, reporting back. */
    private settleRefund = async (
        event: ProviderWebhookEvent,
        ref: MerchantOrderRef,
        afterCommit: Array<() => void>,
        trx: Knex.Transaction,
    ): Promise<WebhookProcessingResult | undefined> => {
        const session = await findSessionByMerchantOrderRef(event.merchantOrderRef, trx, true);
        if (!session) {
            logger.error("refund webhook: no session for merchant order reference", {
                merchantOrderRef: event.merchantOrderRef,
            });
            return {processed: false, reason: "SessionNotFound"};
        }

        const refund = await findPendingRefundToSettle(
            session.orderId,
            event.providerTransactionId,
            trx,
        );

        if (!refund) {
            logger.error("refund webhook: no pending refund to settle", {
                merchantOrderRef: event.merchantOrderRef,
                providerTransactionId: event.providerTransactionId,
            });
            return {processed: false, reason: "RefundNotFound"};
        }

        if (event.outcome === "pending") return undefined;

        const settled = await updateTransactionStatus(
            refund.id,
            TransactionStatus.PENDING,
            {
                status:
                    event.outcome === "succeeded"
                ? TransactionStatus.SUCCEEDED
                : TransactionStatus.FAILED,
                providerReferenceId: event.providerTransactionId,
            },
            trx,
        );
        // Zero rows: the refund had already left `pending`, so this is a
        // replay of an outcome we have recorded.
        if (!settled) return {processed: false, reason: "RefundAlreadySettled"};

        if (event.outcome !== "succeeded") return undefined;

        if (refund.refundedPaymentId) {
            const charge = await findTransactionById(refund.refundedPaymentId, trx);
            if (charge && (await sumRefundedAmount(charge.id, trx)) >= charge.amount) {
                await markChargeFullyRefunded(charge.id, trx);
            }
        }

        const order = await this.orderService.findByPublicId(ref.orderPublicId, trx);
        afterCommit.push(() => {
            wsPublish([wsChannels.customer(order.customerId)], PaymentWsEvent.REFUNDED, {
                orderId: order.publicId,
                refundId: settled.id,
                amount: settled.amount,
                currency: settled.currency,
                ts: new Date().toISOString(),
            });
        });

        return undefined;
    };

    /**
     * Writes a ledger row, yielding to the unique `idempotency_key` if the
     * row is already there.
     *
     * This is the floor beneath the de-dup gate and the row lock: if both are
     * somehow bypassed — two workers, a restored backup, a manual replay —
     * the constraint is still what makes a second credit impossible, and
     * returning `undefined` is how that guarantee reads as a correct outcome
     * rather than a 500. Returns undefined only when the row pre-existed.
     */
    private recordLedgerRow = async (
        input: CreateTransactionInput,
        trx: Knex.Transaction,
    ): Promise<TransactionEntity | undefined> => {
        const created = await createTransactionIfNew(input, trx);
        if (created) return created;

        logger.warn("payment webhook: ledger row already recorded", {
            idempotencyKey: input.idempotencyKey,
        });
        return undefined;
    };

    /** The ledger's idempotency key for an event: provider-scoped, never reused. */
    private ledgerKey = (event: ProviderWebhookEvent): string =>
        `${this.provider.name}:${event.eventId}`;
}

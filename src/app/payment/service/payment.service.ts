import {inject, injectable} from "tsyringe";
import {Knex} from "knex";
import {AppError} from "../../../lib/error/AppError";
import {TOKENS} from "../../../lib/di/tokens";
import {env} from "../../../lib/config/env";
import {logger} from "../../../lib/logger/logger";
import {db} from "../../../lib/knex/knex";
import {toMs} from "../../../pkg/utils/time";
import {IPaymentProvider} from "../../../pkg/payments/payment.interface";
import {SystemRole} from "../../../lib/auth/roles";
import {OrderEntity} from "../../order/entity/order.entity";
import {OrderStatus, PaymentMethod} from "../../order/enums";
import {OrderNotFoundError} from "../../order/errors";
import {OrderRequester, OrderService} from "../../order/service/order.service";
import {PaymentSessionEntity} from "../entity/payment-session.entity";
import {TransactionEntity} from "../entity/transaction.entity";
import {
    PaymentProviderName,
    PaymentSessionStatus,
    TransactionMethod,
    TransactionStatus,
    TransactionType,
} from "../enums";
import {
    fromProviderError,
    NotARefundableChargeError,
    OrderNotOnlinePaymentError,
    OrderNotPendingPaymentError,
    PaymentNotFoundError,
    RefundExceedsChargeError,
} from "../errors";
import {buildMerchantOrderRef} from "../merchant-ref";
import {RefundRequestDTO} from "../dto/payment.request.dto";
import {
    PaymentInitResponseDTO,
    PaymentResponseDTO,
    RefundAcceptedResponseDTO,
} from "../dto/payment.response.dto";
import {findAllProviders} from "../repository/payment-provider.repo";
import {
    countSessionsByOrderId,
    createSession,
    expireSession,
    findCapturedSessionByOrderId,
    findExpiredOpenSessions,
    findLatestSessionByOrderId,
} from "../repository/payment-session.repo";
import {
    createTransaction,
    findTransactionById,
    findTransactionsByOrderId,
    markChargeFullyRefunded,
    sumRefundedAmount,
    updateTransactionStatus,
} from "../repository/transaction.repo";
import {OrderPaymentSummary, PaymentCallContext} from "../types";

/** How many expired sessions one sweep tick closes per region. */
const EXPIRY_SWEEP_BATCH = 200;

@injectable()
export class PaymentService {
    /**
     * id <-> name for `payment_providers`, memoised per region.
     *
     * The table is two rows, replicated identically onto every shard and
     * written only by a migration, so re-reading it on every payment would be
     * a round trip to learn a constant. Memoising per region rather than
     * globally keeps the cache honest about where the number came from, and
     * costs one extra query per region per process lifetime.
     */
    private readonly providersByRegion = new Map<
        string,
        {byName: Map<string, number>; byId: Map<number, PaymentProviderName>}
    >();

    constructor(
        @inject(TOKENS.PaymentProvider) private readonly provider: IPaymentProvider,
        @inject(TOKENS.OrderService) private readonly orderService: OrderService,
    ) {}

    /**
     * POST /api/payments/init (docs/business-logic/payments.md s2).
     *
     * Idempotent twice over: the middleware replays an identical
     * `Idempotency-Key`, and below that the *domain* is idempotent too — an
     * order that already has a payable session gets that session back rather
     * than a second one. The two guard different things. The middleware stops
     * a retried HTTP request; the session re-use stops a customer who
     * abandoned the checkout tab and pressed "pay" again from leaving a trail
     * of live sessions at the provider, each of which could still be paid.
     */
    init = async (
        orderPublicId: string,
        requester: OrderRequester,
        ctx: PaymentCallContext,
    ): Promise<PaymentInitResponseDTO> => {
        const conn = db(ctx.region);
        const order = await this.orderService.findByPublicId(orderPublicId, conn);

        // 404 rather than 403 for someone else's order: the caller has no
        // legitimate view of it, and confirming it exists tells them
        // something they shouldn't learn.
        if (requester.role !== SystemRole.SYSTEM_ADMIN && order.customerId !== requester.userId) {
            throw OrderNotFoundError;
        }

        const session = await this.openSessionFor(order, ctx, conn);
        return PaymentInitResponseDTO.from(session);
    };

    /**
     * The session half of `init`, without the HTTP-level authorisation —
     * shared with the auto-init on `POST /api/orders`, which has already
     * established who the caller is by placing the order as them.
     *
     * Returns the live session when there is one. Everything else is a fresh
     * attempt, and every attempt gets its own merchant reference because the
     * provider refuses to reuse one.
     */
    openSessionFor = async (
        order: OrderEntity,
        ctx: PaymentCallContext,
        conn: Knex = db(ctx.region),
    ): Promise<PaymentSessionEntity> => {
        if (order.paymentMethod !== PaymentMethod.ONLINE) throw OrderNotOnlinePaymentError;
        if (order.status !== OrderStatus.PENDING_PAYMENT) throw OrderNotPendingPaymentError;

        const latest = await findLatestSessionByOrderId(order.id, conn);
        if (latest?.isOpen()) return latest;

        const attempt = (await countSessionsByOrderId(order.id, conn)) + 1;
        const merchantOrderRef = buildMerchantOrderRef(order.region, order.publicId, attempt);
        const expiresAt = new Date(Date.now() + toMs(env.payments.sessionTimeoutMin, "m"));

        let created;
        try {
            created = await this.provider.createSession({
                merchantOrderRef,
                amountMinor: order.total,
                currency: order.currency,
                returnUrl: env.payments.kashier.returnUrl,
                webhookUrl: env.payments.kashier.serverWebhookUrl,
                customerReference: String(order.customerId),
                description: `Order ${order.publicId}`,
                expiresAt,
            });
        } catch (err) {
            logger.error("payment session creation failed", {
                orderPublicId: order.publicId,
                merchantOrderRef,
                correlationId: ctx.correlationId,
                error: (err as Error).message,
            });
            throw fromProviderError(err);
        }

        const providerId = await this.providerIdOf(this.provider.name, ctx.region, conn);

        return createSession(
            {
                region: order.region,
                orderId: order.id,
                orderPublicId: order.publicId,
                providerId,
                merchantOrderRef,
                providerSessionId: created.providerSessionId,
                redirectUrl: created.redirectUrl,
                amount: order.total,
                currency: order.currency,
                status: PaymentSessionStatus.INITIALIZED,
                expiresAt: created.expiresAt,
                rawInitPayload: created.requestPayload,
            },
            conn,
        );
    };

    /**
     * GET /api/payments/{paymentId}.
     *
     * The "payment" a client sees is a `transactions` row, which is why the
     * authorization has to walk back to the order: a ledger row on its own
     * says nothing about who may read it.
     */
    getById = async (
        paymentId: number,
        requester: OrderRequester,
        region: string,
    ): Promise<PaymentResponseDTO> => {
        const conn = db(region);
        const transaction = await findTransactionById(paymentId, conn);
        if (!transaction) throw PaymentNotFoundError;

        await this.assertCanReadTransaction(transaction, requester, conn);

        const names = await this.providerNames(region, conn);
        return PaymentResponseDTO.from(
            transaction,
            transaction.providerId === null ? null : (names.get(transaction.providerId) ?? null),
        );
    };

    /**
     * POST /api/payments/{paymentId}/refund (docs/business-logic/payments.md s5).
     *
     * The row is written `pending` *before* the provider is called, and the
     * provider call happens outside any transaction. Both deliberately:
     *
     *  - Writing first means a crash between the two leaves a visible pending
     *    refund rather than money moving with nothing to show for it. The
     *    webhook settles it either way.
     *  - Holding a transaction open across an HTTP call to a third party ties
     *    a row lock to someone else's latency, and the one row involved is
     *    the charge every other refund attempt on this order also wants.
     *
     * 202, not 200: Kashier accepting a refund is not the same as the money
     * having moved, and the webhook is what makes it `succeeded`.
     */
    refund = async (
        paymentId: number,
        input: RefundRequestDTO,
        region: string,
        ctx: PaymentCallContext,
    ): Promise<RefundAcceptedResponseDTO> => {
        const conn = db(region);
        const charge = await findTransactionById(paymentId, conn);
        if (!charge) throw PaymentNotFoundError;
        if (!charge.isRefundableCharge()) throw NotARefundableChargeError;

        const alreadyRefunded = await sumRefundedAmount(charge.id, conn);
        const remaining = charge.amount - alreadyRefunded;
        const amount = input.amount ?? remaining;
        if (amount <= 0 || amount > remaining) throw RefundExceedsChargeError;

        // COD never reached the platform's balance, so there is nothing to
        // send back through a provider — the refund is a bookkeeping entry
        // that settles immediately. The restaurant-balance side of it lands
        // with the settlement ledger in Phase 3.
        if (charge.method === TransactionMethod.COD) {
            const refund = await this.writeRefundRow(charge, amount, TransactionStatus.SUCCEEDED, ctx, conn);
            await this.settleChargeIfFullyRefunded(charge, conn);
            return RefundAcceptedResponseDTO.from(refund);
        }

        const session = await findCapturedSessionByOrderId(charge.orderId!, conn);
        if (!session?.providerOrderId) {
            // No captured session means we never learned the provider's order
            // id, and its refund endpoint is addressed by exactly that. A
            // charge in this state is a data problem, not a client one.
            logger.error("refund blocked: no captured session for charge", {
                paymentId,
                orderId: charge.orderId,
            });
            throw NotARefundableChargeError;
        }

        const refund = await this.writeRefundRow(charge, amount, TransactionStatus.PENDING, ctx, conn);

        try {
            const result = await this.provider.refund({
                providerOrderId: session.providerOrderId,
                amountMinor: amount,
                currency: charge.currency,
                reason: input.reason,
                targetProviderTransactionId: charge.providerReferenceId ?? undefined,
            });

            if (result.status === "failed") {
                await updateTransactionStatus(
                    refund.id,
                    TransactionStatus.PENDING,
                    {status: TransactionStatus.FAILED, providerReferenceId: result.providerTransactionId},
                    conn,
                );
                throw new AppError("RefundRejected", 502, true, {provider: this.provider.name});
            }

            // Record the provider's id for the refund even when it already
            // reports success: it is how the webhook finds this row again.
            const settled = await updateTransactionStatus(
                refund.id,
                TransactionStatus.PENDING,
                {
                    status:
                        result.status === "succeeded"
                            ? TransactionStatus.SUCCEEDED
                            : TransactionStatus.PENDING,
                    providerReferenceId: result.providerTransactionId,
                },
                conn,
            );

            if (result.status === "succeeded") await this.settleChargeIfFullyRefunded(charge, conn);
            return RefundAcceptedResponseDTO.from(settled ?? refund);
        } catch (err) {
            if (err instanceof AppError) throw err;

            // The provider never answered. The row stays `pending`, which is
            // the truth: we don't know whether the money moved, and the
            // webhook is the only thing that can tell us.
            logger.error("refund call failed; leaving refund pending", {
                paymentId,
                refundId: refund.id,
                correlationId: ctx.correlationId,
                error: (err as Error).message,
            });
            throw fromProviderError(err);
        }
    };

    /**
     * The payment block on `GET /api/orders/{publicId}`, read from the ledger
     * rather than inferred from the order's status — which is what Phase 1
     * had to do, and what made a captured-then-refunded order indistinguishable
     * from a cancelled one.
     */
    summarizeForOrder = async (order: OrderEntity, conn: Knex): Promise<OrderPaymentSummary> => {
        const ledger = await findTransactionsByOrderId(order.id, conn);

        const charge = ledger.find(
            (t) =>
                (t.type === TransactionType.CHARGE || t.type === TransactionType.COD_COLLECTION) &&
                t.status === TransactionStatus.SUCCEEDED,
        );
        const refundedAmount = ledger
            .filter((t) => t.type === TransactionType.REFUND && t.status === TransactionStatus.SUCCEEDED)
            .reduce((sum, t) => sum + t.amount, 0);

        return {
            method: order.paymentMethod,
            status: this.summaryStatus(order, ledger, charge, refundedAmount),
            amount: order.total,
            currency: order.currency,
            refundedAmount,
        };
    };

    /**
     * Closes payment sessions nobody can pay on any more, and cancels the
     * orders behind them.
     *
     * This is not housekeeping. An online order holds *reserved stock* from
     * the moment it is placed — core decremented it before the order row was
     * written — so an abandoned checkout keeps units out of circulation
     * until something gives them back. The 15-minute session timeout is what
     * bounds that, and this is what enforces it.
     *
     * Everything here is a compare-and-set, so two workers sweeping the same
     * region at once produce one cancellation, and a capture that lands
     * mid-sweep wins: `expireSession` sees a status that is no longer open
     * and the order is left alone.
     */
    expireStaleSessions = async (region: string): Promise<number> => {
        const conn = db(region);
        const stale = await findExpiredOpenSessions(new Date(), EXPIRY_SWEEP_BATCH, conn);

        let cancelled = 0;
        for (const session of stale) {
            try {
                if (!(await expireSession(session.id, conn))) continue;

                const order = await this.orderService.findByPublicId(session.orderPublicId, conn);
                if (order.status !== OrderStatus.PENDING_PAYMENT) continue;

                await this.orderService.cancelUnpaidOrder(order, conn);
                cancelled++;
            } catch (err) {
                // One bad session must not stop the sweep: the rest of the
                // batch is other customers' stock.
                logger.error("payment expiry sweep failed for session", {
                    region,
                    sessionId: session.id,
                    error: (err as Error).message,
                });
            }
        }

        if (cancelled > 0) logger.info("payment expiry sweep cancelled orders", {region, cancelled});
        return cancelled;
    };

    /** name -> id for this shard's provider lookup. */
    providerIdOf = async (name: string, region: string, conn: Knex): Promise<number> => {
        const providers = await this.loadProviders(region, conn);
        const id = providers.byName.get(name);
        if (id === undefined) {
            throw new AppError(`Payment provider "${name}" is not seeded on shard ${region}`, 500);
        }
        return id;
    };

    private providerNames = async (
        region: string,
        conn: Knex,
    ): Promise<Map<number, PaymentProviderName>> => (await this.loadProviders(region, conn)).byId;

    private loadProviders = async (region: string, conn: Knex) => {
        const cached = this.providersByRegion.get(region);
        if (cached) return cached;

        const rows = await findAllProviders(conn);
        const entry = {
            byName: new Map(rows.map((p) => [p.name as string, p.id])),
            byId: new Map(rows.map((p) => [p.id, p.name])),
        };
        this.providersByRegion.set(region, entry);
        return entry;
    };

    private writeRefundRow = async (
        charge: TransactionEntity,
        amount: number,
        status: TransactionStatus,
        ctx: PaymentCallContext,
        conn: Knex,
    ): Promise<TransactionEntity> =>
        createTransaction(
            {
                region: charge.region,
                orderId: charge.orderId,
                orderPublicId: charge.orderPublicId,
                type: TransactionType.REFUND,
                // The refund travels the rail the charge came in on.
                method: charge.method,
                providerId: charge.providerId,
                status,
                amount,
                currency: charge.currency,
                // Platform -> customer: the mirror of the charge's direction.
                srcAccId: null,
                dstAccId: charge.srcAccId,
                refundedPaymentId: charge.id,
                // Scoped to the charge so the same admin key can't refund two
                // different payments, and so a retried request collides on the
                // unique constraint rather than refunding twice.
                idempotencyKey: ctx.idempotencyKey
                    ? `refund:${charge.id}:${ctx.idempotencyKey}`
                    : null,
            },
            conn,
        );

    /**
     * Flags the charge once the refunds against it add up to its full amount.
     * Partial refunds leave it unflagged on purpose — the remaining headroom
     * is the sum, and a boolean can't express "half".
     */
    private settleChargeIfFullyRefunded = async (
        charge: TransactionEntity,
        conn: Knex,
    ): Promise<void> => {
        const refunded = await sumRefundedAmount(charge.id, conn);
        if (refunded >= charge.amount) await markChargeFullyRefunded(charge.id, conn);
    };

    private summaryStatus = (
        order: OrderEntity,
        ledger: TransactionEntity[],
        charge: TransactionEntity | undefined,
        refundedAmount: number,
    ): OrderPaymentSummary["status"] => {
        if (refundedAmount > 0) return "refunded";
        if (charge) return "captured";
        if (ledger.some((t) => t.status === TransactionStatus.FAILED)) return "failed";
        // No ledger row yet. A COD order is simply unpaid until delivery; an
        // online one is waiting on the customer or on the webhook.
        if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED) {
            return "failed";
        }
        return "pending";
    };

    /**
     * System admins read anything. A restaurant user reads a payment only if
     * it belongs to an order of their restaurant, and a customer only their
     * own — which means loading the order, because the ledger row carries no
     * tenancy of its own.
     */
    private assertCanReadTransaction = async (
        transaction: TransactionEntity,
        requester: OrderRequester,
        conn: Knex,
    ): Promise<void> => {
        if (requester.role === SystemRole.SYSTEM_ADMIN) return;
        if (!transaction.orderPublicId) throw PaymentNotFoundError;

        const order = await this.orderService.findByPublicId(transaction.orderPublicId, conn);
        // Reuse the order module's own rule rather than restating it here:
        // two copies of a tenancy check are two chances to disagree. It
        // throws OrderNotFound, which we re-label — the caller asked about a
        // payment, and the existence of the order is not theirs to learn.
        try {
            this.orderService.assertCanRead(order, requester);
        } catch {
            throw PaymentNotFoundError;
        }
    };
}

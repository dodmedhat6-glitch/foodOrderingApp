import {container, inject, injectable} from "tsyringe";
import {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens";
import {env} from "../../../lib/config/env";
import {logger} from "../../../lib/logger/logger";
import {db} from "../../../lib/knex/knex";
import {toMs} from "../../../pkg/utils/time";
import {
    buildPaginationResultBy,
    PaginationMeta,
    PaginationParams,
} from "../../../lib/http/pagination/cursor-pagination";
import {OrderEntity} from "../entity/order.entity";
import {OrderActor, OrderStatus} from "../enums";
import {ListOrdersFilters, OrderRequester, OrderScope, UpdateOrderStatusInput} from "../types";
import {
    CancellationWindowExpiredError,
    dispatchManagedTransitionError,
    OrderNotFoundError,
} from "../errors";
import {
    findOrderByPublicId,
    findOrdersByBranch,
    findOrdersByCustomer,
    promoteClaimedReadyOrder,
    updateOrderStatus,
} from "../repository/order.repo";
import {countItemsByOrderIds, findItemsByOrderIds} from "../repository/order-item.repo";
import {
    OrderDetailResponseDTO,
    OrderStatusResponseDTO,
    OrderSummaryResponseDTO,
} from "../dto/order.response.dto";
import {assertCanReadOrder, resolveActor} from "../policy";
import {releaseReservedStock} from "../stock";
import {publicIdWindow, yearWindow} from "../windows";
import {OrderStatusService} from "./order-status.service";
import {OrderNotifier} from "./order-notifier.service";
// Type-only: the payment module imports this one, and a value import here
// would close the cycle at require() time. The instance is resolved from the
// container at call time instead (see `payments`).
import type {PaymentService} from "../../payment/service/payment.service";
// Type-only for the same reason: the delivery module imports this file.
import type {DeliveryService} from "../../delivery/service/delivery.service";

/** `status_reason` on an order the payment-expiry sweep cancels. */
const PAYMENT_EXPIRED_REASON = "payment_session_expired";

/**
 * Statuses an order can be rejected or cancelled *from* and still hand its
 * stock back to core.
 *
 * Everything before the kitchen starts. Once an order is `preparing` the
 * units have been cooked: returning them would let the branch sell food that
 * is already in a bin or a bag, so a later cancellation keeps them sold.
 * `pending_payment` is here for the customer cancelling their own unpaid
 * checkout; the expiry sweep's cancellation releases through
 * `cancelUnpaidOrder` instead.
 */
const STOCK_RETURNABLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PLACED,
    OrderStatus.ACCEPTED,
]);

/**
 * Targets `PATCH /status` refuses outright, whoever is asking.
 *
 * Both edges move more than the status: entering `assigned` writes
 * `delivery_agent_id` and `assigned_at`, and leaving it clears them. Reached
 * through the generic status endpoint they would move the status alone, and an
 * order would end up `ready` with an agent still attached — or `assigned` to
 * nobody.
 *
 * The status machine already restricts both edges to `OrderActor.SYSTEM`, but
 * an admin may traverse any edge that exists, so the machine alone does not
 * close this. The dispatch endpoints (`/claim`, `/unclaim`, `/assign`) write
 * every column in one UPDATE and are the only way in.
 */
const DISPATCH_MANAGED_TARGETS: ReadonlySet<OrderStatus> = new Set([
    OrderStatus.ASSIGNED,
    OrderStatus.READY,
]);

/**
 * Agent transitions the delivery module handles rather than this one. Both
 * carry side effects beyond the status column — a presence update, and in
 * `delivered`'s case the whole settlement transaction.
 */
const DELIVERY_OWNED_TARGETS: ReadonlySet<OrderStatus> = new Set([
    OrderStatus.PICKED,
    OrderStatus.DELIVERED,
]);

/**
 * Reads and status transitions of an existing order.
 *
 * Placement lives in `OrderPlacementService`, the agent/dispatch data
 * operations in `OrderDispatchService`, and the post-commit broadcasts in
 * `OrderNotifier`.
 */
@injectable()
export class OrderService {
    constructor(
        @inject(TOKENS.OrderStatusService) private readonly statusService: OrderStatusService,
        @inject(TOKENS.OrderNotifier) private readonly notifier: OrderNotifier,
    ) {}

    private payments = (): PaymentService =>
        container.resolve<PaymentService>(TOKENS.PaymentService);

    /**
     * Resolved per call, not injected, for the same reason as `payments`: the
     * delivery module imports this service, so a constructor dependency the
     * other way would close the cycle at require() time.
     */
    private delivery = (): DeliveryService =>
        container.resolve<DeliveryService>(TOKENS.DeliveryService);

    /**
     * One order in full — header, lines, payment summary, timeline.
     *
     * Serves both shapes of the read, and `scope` is the only difference
     * between them:
     *  - `GET /api/orders/{publicId}` — the caller-scoped read. A customer or
     *    an agent holds the public id and nothing else; who may see it is
     *    decided entirely by `assertCanReadOrder`.
     *  - `GET /api/restaurants/{restaurantId}/branches/{branchId}/orders/{publicId}`
     *    — restaurant staff, where the path already names the tenancy that
     *    `rbac()` and `requireBranchAccess` were applied against. Passing it
     *    down means the query filters on it too, so an order id from another
     *    branch of the same restaurant finds no row rather than relying on the
     *    assertion below to turn it away.
     */
    getOrder = async (
        publicId: string,
        region: string,
        requester: OrderRequester,
        scope?: OrderScope,
    ): Promise<OrderDetailResponseDTO> => {
        const conn = db(region);
        const order = await this.findByPublicId(publicId, conn, scope);

        assertCanReadOrder(order, requester);

        const items = await findItemsByOrderIds([order.id], conn);
        const paymentSummary = await this.payments().summarizeForOrder(order, conn);
        // Who is bringing it. Resolved through the delivery module, which owns
        // the agent lookup and its failure policy — an unreachable core must
        // not fail a customer's tracking screen.
        const delivery = await this.delivery().summarize(order);
        return OrderDetailResponseDTO.fromDetail(order, items, paymentSummary, undefined, delivery);
    };

    /**
     * The order behind a public id, with no authorisation check — for callers
     * that have already established their own right to it, or that have no
     * HTTP caller at all (the payment webhook, the expiry sweep). Takes the
     * connection so it can join a transaction the caller owns.
     *
     * Name is caller-agnostic on purpose (CLAUDE.md s8): a `findByPublicId`
     * is a `findByPublicId` whoever asks. The authorisation lives in
     * `getOrder` and in `assertCanRead`, which callers that need it invoke
     * explicitly rather than getting silently.
     *
     * `scope` is for the callers that *do* have an HTTP caller behind a
     * `/restaurants/:restaurantId/branches/:branchId/...` path — the payment
     * read is one — so their lookup filters on the branch too and never sees
     * an order outside it. The webhook and the sweeps pass none.
     */
    findByPublicId = async (
        publicId: string,
        conn: Knex,
        scope?: OrderScope,
    ): Promise<OrderEntity> => {
        const order = await findOrderByPublicId(publicId, conn, publicIdWindow(publicId), scope);
        if (!order) throw OrderNotFoundError;
        return order;
    };

    /**
     * GET /api/customer/orders?year=YYYY. The year bounds the scan to that
     * year's partitions; it defaults to the current one, which is the only
     * year the hot database keeps (CLAUDE.md s7/Archival).
     */
    listCustomerOrders = async (
        requester: OrderRequester,
        region: string,
        params: PaginationParams,
        year: number,
    ): Promise<{data: OrderSummaryResponseDTO[]; meta: PaginationMeta}> => {
        const conn = db(region);
        const orders = await findOrdersByCustomer(requester.userId, params, yearWindow(year), conn);
        return this.toSummaryPage(orders, params, conn);
    };

    /**
     * GET /api/restaurants/{restaurantId}/branches/{branchId}/orders — the
     * branch-scoped operations dashboard.
     *
     * Takes the whole scope rather than a bare branch id: the pair comes from
     * the path, and handing the repository both is what keeps a mismatched
     * pair returning an empty page instead of another restaurant's queue.
     */
    listRestaurantOrders = async (
        scope: OrderScope,
        params: PaginationParams,
        filters: ListOrdersFilters,
        region: string,
    ): Promise<{data: OrderSummaryResponseDTO[]; meta: PaginationMeta}> => {
        const conn = db(region);
        const orders = await findOrdersByBranch(scope, params, filters, conn);
        return this.toSummaryPage(orders, params, conn);
    };

    /**
     * PATCH /api/orders/{publicId}/status (docs/business-logic/orders.md s7).
     *
     * The actor is derived from the token, never from the body, and the
     * transition is validated against the status machine before anything is
     * written. The update itself is a compare-and-set on the current status,
     * so two restaurant staff accepting the same order at once produce one
     * transition and one 409 rather than two.
     */
    updateStatus = async (
        publicId: string,
        target: OrderStatus,
        reason: string | undefined,
        requester: OrderRequester,
        region: string,
        scope?: OrderScope,
    ): Promise<OrderStatusResponseDTO> => {
        const conn = db(region);
        const order = await this.findByPublicId(publicId, conn, scope);

        assertCanReadOrder(order, requester);

        // `ready` is a legal target only from `preparing`; from `assigned` it
        // is an unclaim, which has its own endpoint because it has to clear the
        // agent too.
        if (
            DISPATCH_MANAGED_TARGETS.has(target) &&
            !(target === OrderStatus.READY && order.status === OrderStatus.PREPARING)
        ) {
            throw dispatchManagedTransitionError(order.status, target);
        }

        const actor = resolveActor(requester);
        this.statusService.assertReason(target, reason);
        const timestampColumn = this.statusService.assertTransition(order.status, target, actor);

        // `picked` and `delivered` belong to the delivery module: the second
        // one is a settlement that happens to end in a status change, and
        // writing it here would move the status without the money. The
        // endpoint stays the single one this service exposes (CLAUDE.md s4) —
        // only the handler differs.
        if (actor === OrderActor.AGENT && DELIVERY_OWNED_TARGETS.has(target)) {
            const moved = await this.delivery().handleAgentTransition(
                order,
                target,
                requester.userId,
            );
            return OrderStatusResponseDTO.from(moved);
        }

        if (
            actor === OrderActor.CUSTOMER &&
            target === OrderStatus.CANCELLED &&
            !order.isWithinCustomerCancellationWindow(
                toMs(env.orders.customerCancellationWindowSec, "s"),
            )
        ) {
            throw CancellationWindowExpiredError;
        }

        const transitionInput = {status: target, statusReason: reason ?? null, timestampColumn};
        const written: {updated: OrderEntity; promoted?: OrderEntity} | undefined =
            target === OrderStatus.READY
                ? await this.writeReady(order, transitionInput, conn)
                : await updateOrderStatus(
                      order.id,
                      order.createdAt,
                      order.status,
                      transitionInput,
                      conn,
                  ).then((updated) => (updated ? {updated} : undefined));
        // Zero rows means the status moved under us between the read and the
        // write; the transition we validated is no longer the one on offer.
        if (!written) throw OrderNotFoundError;

        const updated = written.promoted ?? written.updated;
        await this.notifier.announceTransition(written.updated, reason);
        if (written.promoted) await this.notifier.announceTransition(written.promoted);
        await this.returnStockIfUncooked(written.updated, order);
        await this.refundIfCancelled(written.updated, reason);
        await this.afterTransition(updated, order, reason);

        return OrderStatusResponseDTO.from(updated);
    };

    /**
     * The kitchen's `ready`, plus the promotion an early claim is owed.
     *
     * Dispatch starts at `preparing`, so an agent may already hold the order
     * when the food comes up. Such an order must leave this write `assigned`,
     * not `ready`: the sweep skips orders with an agent attached and
     * `markPicked` needs `assigned`, so a committed `ready`-with-agent would be
     * stranded between the two. Both writes therefore share one transaction.
     *
     * The decision reads the agent off the row the `ready` write *returned*,
     * not off the order read before it. A claim that lands between that read
     * and this write is visible here, and would otherwise be missed.
     */
    private writeReady = async (
        order: OrderEntity,
        input: UpdateOrderStatusInput,
        conn: Knex,
    ): Promise<{updated: OrderEntity; promoted?: OrderEntity} | undefined> => {
        const trx = await conn.transaction();
        try {
            const updated = await updateOrderStatus(order.id, order.createdAt, order.status, input, trx);
            if (!updated) {
                await trx.rollback();
                return undefined;
            }

            let promoted: OrderEntity | undefined;
            if (updated.deliveryAgentId) {
                this.statusService.assertTransition(
                    OrderStatus.READY,
                    OrderStatus.ASSIGNED,
                    OrderActor.SYSTEM,
                );
                promoted = await promoteClaimedReadyOrder(updated.id, updated.createdAt, trx);
                // The row was `ready` with an agent a moment ago inside this
                // same transaction; nothing else can have moved it.
                if (!promoted) throw OrderNotFoundError;
            }

            await trx.commit();
            return {updated, promoted};
        } catch (err) {
            if (!trx.isCompleted()) await trx.rollback();
            throw err;
        }
    };

    /**
     * Hands a rejected or cancelled order's units back to core, if the kitchen
     * never started on them (`STOCK_RETURNABLE_STATUSES`).
     *
     * `previous.status` is the status the compare-and-set matched, so it is
     * exactly the state the order left — not a stale read. And because only
     * one writer can win that compare-and-set, this runs at most once per
     * order, which `releaseStock` needs: core has no ledger to dedupe a second
     * release against.
     *
     * After the commit, for the same reason `cancelUnpaidOrder` is: core cannot
     * join our transaction, and a cancelled order whose release failed (logged
     * loudly by `releaseReservedStock`) is the survivable side of the two.
     */
    private returnStockIfUncooked = async (
        updated: OrderEntity,
        previous: OrderEntity,
    ): Promise<void> => {
        if (updated.status !== OrderStatus.REJECTED && updated.status !== OrderStatus.CANCELLED) return;
        if (!STOCK_RETURNABLE_STATUSES.has(previous.status)) return;

        const items = await findItemsByOrderIds([updated.id], db(updated.region));
        await releaseReservedStock(
            updated.branchId,
            items.map((item) => ({productId: item.productId, quantity: item.quantity})),
            {},
        );
    };

    /**
     * Refunds a rejected or cancelled order's online payment, in full —
     * whatever status it was cancelled from, unlike the stock: the customer
     * gets no food, so they keep no charge.
     *
     * Awaited rather than fired and forgotten, so the refund row exists by the
     * time the caller hears the cancellation succeeded; but it never fails the
     * request (`PaymentService.refundCancelledOrder` logs and swallows), since
     * the cancellation has already committed.
     */
    private refundIfCancelled = async (updated: OrderEntity, reason?: string): Promise<void> => {
        if (updated.status !== OrderStatus.REJECTED && updated.status !== OrderStatus.CANCELLED) return;

        await this.payments().refundCancelledOrder(updated, `order_${updated.status}: ${reason ?? ""}`);
    };

    /**
     * Side effects a transition owes to dispatch, run after the write commits.
     *
     * Two cases, and both are *nudges* rather than mechanisms:
     *
     *  - **`preparing`, or `ready` with nobody attached** — tell the sweep
     *    there is work, so an order is offered in milliseconds instead of on
     *    the next tick. The sweep remains the thing that guarantees the offer
     *    happens; this only makes the common case fast. That is why a failure
     *    here is logged and dropped: the worst outcome is a wait of one sweep
     *    interval.
     *  - **`cancelled`** — free the agent who was carrying it and tell them to
     *    stop driving. This is the Redis side plus the courtesy. The agent is
     *    read off the written row first: with dispatch open from `preparing`,
     *    a claim can land between the read and the cancellation, and the
     *    pre-write copy would not know about it.
     *
     * Best-effort throughout. The transition has committed, and nothing here
     * can un-commit it — turning a notification failure into a 500 would tell
     * the caller their cancellation failed when it did not.
     */
    private afterTransition = async (
        updated: OrderEntity,
        previous: OrderEntity,
        reason?: string,
    ): Promise<void> => {
        try {
            if (
                (updated.status === OrderStatus.PREPARING || updated.status === OrderStatus.READY) &&
                !updated.deliveryAgentId
            ) {
                await this.delivery().nudgeDispatch(updated);
                return;
            }
            if (updated.status === OrderStatus.CANCELLED) {
                const carrier = updated.deliveryAgentId ? updated : previous;
                if (carrier.deliveryAgentId) {
                    await this.delivery().releaseOnCancellation(carrier, reason);
                }
            }
        } catch (err) {
            logger.warn("post-transition dispatch hook failed", {
                orderPublicId: updated.publicId,
                status: updated.status,
                error: (err as Error).message,
            });
        }
    };

    /**
     * A transition no human requested: the payment webhook placing an order
     * once the capture lands, the expiry sweep cancelling one that was never
     * paid, the assignment service moving one to `assigned` (Phase 3).
     *
     * Takes the caller's transaction, because the point of a system
     * transition is that it commits with whatever made it true — an order
     * that is `placed` with no charge row, or a charge row against an order
     * still waiting for payment, are both states nobody should be able to
     * observe.
     *
     * Still goes through the status machine with `OrderActor.SYSTEM`: being
     * the system is permission to traverse the system's edges, not licence to
     * invent one.
     */
    transitionBySystem = async (
        order: OrderEntity,
        target: OrderStatus,
        conn: Knex,
        reason?: string,
    ): Promise<OrderEntity> => this.transitionInTrx(order, target, OrderActor.SYSTEM, conn, {reason});

    /**
     * The same thing for an actor who is not the system — today, an agent
     * stamping `picked` or `delivered` inside the settlement transaction.
     *
     * Exists because settlement is one unit of work: the status flip, the
     * commission stamp, the ledger rows, the balance and the agent's earning
     * all commit together or not at all. The public `updateStatus` runs its own
     * write and cannot be enlisted in somebody else's transaction, so the
     * delivery module composes this instead.
     *
     * `commission` rides along so it lands in the *same* UPDATE as the status:
     * a settled order and its commission can then never disagree.
     */
    transitionInTrx = async (
        order: OrderEntity,
        target: OrderStatus,
        actor: OrderActor,
        conn: Knex,
        opts: {reason?: string; commission?: number} = {},
    ): Promise<OrderEntity> => {
        const timestampColumn = this.statusService.assertTransition(order.status, target, actor);

        const updated = await updateOrderStatus(
            order.id,
            order.createdAt,
            order.status,
            {
                status: target,
                statusReason: opts.reason ?? null,
                timestampColumn,
                commission: opts.commission,
            },
            conn,
        );
        // Zero rows means something else moved the order between the read and
        // the write. The caller's transaction must not commit on a stale
        // premise, so this is an error rather than a silent no-op.
        if (!updated) throw OrderNotFoundError;

        return updated;
    };

    /**
     * Cancels an online order whose payment never arrived, and gives the
     * stock back.
     *
     * The stock release is the part that matters. An online order holds units
     * core decremented before the order row existed, so an abandoned checkout
     * takes them out of circulation until something returns them — this is
     * that something. It runs after the cancellation commits, not inside it:
     * core is a different database and cannot join our transaction, and the
     * order of the two is chosen the same way placement chooses it, by which
     * failure is survivable. A cancelled order whose release failed leaks
     * stock and is logged loudly; a release that happened for an order that
     * then failed to cancel would hand out units an order still claims.
     */
    cancelUnpaidOrder = async (order: OrderEntity, conn: Knex): Promise<OrderEntity> => {
        const items = await findItemsByOrderIds([order.id], conn);
        const cancelled = await this.transitionBySystem(
            order,
            OrderStatus.CANCELLED,
            conn,
            PAYMENT_EXPIRED_REASON,
        );

        await releaseReservedStock(
            order.branchId,
            items.map((item) => ({productId: item.productId, quantity: item.quantity})),
            {},
        );

        await this.notifier.announceTransition(cancelled, PAYMENT_EXPIRED_REASON);
        return cancelled;
    };

    /**
     * The read rule, for other modules that hold an order and a caller and
     * need the same answer this module would give — `GET /api/payments/{id}`
     * authorises against the order behind the ledger row. Exposed rather than
     * restated there, because two copies of a tenancy check are two chances
     * to disagree.
     */
    assertCanRead = (order: OrderEntity, requester: OrderRequester): void =>
        assertCanReadOrder(order, requester);

    /** Items counts for a page of orders: one grouped query, never per row. */
    private toSummaryPage = async (
        orders: OrderEntity[],
        params: PaginationParams,
        conn: Knex,
    ): Promise<{data: OrderSummaryResponseDTO[]; meta: PaginationMeta}> => {
        const page = buildPaginationResultBy(orders, params.limit, (order) =>
            String(order.createdAt.getTime()),
        );

        const counts = await countItemsByOrderIds(
            page.data.map((order) => order.id),
            conn,
        );
        const countByOrderId = new Map(counts.map((c) => [c.orderId, c.count]));

        return {
            data: page.data.map((order) =>
                OrderSummaryResponseDTO.from(order, countByOrderId.get(order.id) ?? 0),
            ),
            meta: page.meta,
        };
    };
}

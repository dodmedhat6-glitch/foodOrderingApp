import {injectable} from "tsyringe";
import {OrderActor, OrderStatus, STATUS_TIMESTAMP_COLUMN, STATUSES_REQUIRING_REASON} from "../enums";
import {invalidStatusTransitionError, ReasonRequiredError} from "../errors";

/**
 * The order status machine, as a table.
 *
 * One entry per legal edge, listing which actors may traverse it. This is the
 * literal encoding of the matrix in docs/business-logic/orders.md s1 — keeping
 * it declarative means a rule change is a data change, and that an illegal
 * transition can't be reached by some branch nobody re-read.
 *
 * Two things this table does NOT decide, because they need the order row
 * rather than just its status: the customer's 60-second cancellation window
 * (OrderEntity.isWithinCustomerCancellationWindow) and ownership. The service
 * checks those alongside `assertTransition`.
 */
const TRANSITIONS: ReadonlyArray<{
    from: OrderStatus;
    to: OrderStatus;
    actors: ReadonlyArray<OrderActor>;
}> = [
    // Online orders become real when the payment is captured (Phase 2 webhook).
    {from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.PLACED, actors: [OrderActor.SYSTEM]},
    {
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.CANCELLED,
        actors: [OrderActor.CUSTOMER, OrderActor.SYSTEM, OrderActor.ADMIN],
    },

    {from: OrderStatus.PLACED, to: OrderStatus.ACCEPTED, actors: [OrderActor.RESTAURANT]},
    {from: OrderStatus.PLACED, to: OrderStatus.REJECTED, actors: [OrderActor.RESTAURANT]},
    {
        from: OrderStatus.PLACED,
        to: OrderStatus.CANCELLED,
        actors: [OrderActor.CUSTOMER, OrderActor.SYSTEM, OrderActor.ADMIN],
    },

    {from: OrderStatus.ACCEPTED, to: OrderStatus.PREPARING, actors: [OrderActor.RESTAURANT]},
    {
        from: OrderStatus.ACCEPTED,
        to: OrderStatus.CANCELLED,
        actors: [OrderActor.RESTAURANT, OrderActor.ADMIN],
    },

    {from: OrderStatus.PREPARING, to: OrderStatus.READY, actors: [OrderActor.RESTAURANT]},
    {
        from: OrderStatus.PREPARING,
        to: OrderStatus.CANCELLED,
        actors: [OrderActor.RESTAURANT, OrderActor.ADMIN],
    },

    // `assigned` is never written by PATCH /status. It is written by the
    // claim — a conditional UPDATE that is also the arbiter of the dispatch
    // race (order.repo.claimOrderForAgent) — and the admin override goes
    // through POST /api/orders/{publicId}/assign. The edge is listed because
    // the claim still validates against this table before writing: being the
    // system is permission to traverse the system's edges, not licence to
    // invent one.
    {from: OrderStatus.READY, to: OrderStatus.ASSIGNED, actors: [OrderActor.SYSTEM]},
    {
        from: OrderStatus.READY,
        to: OrderStatus.CANCELLED,
        actors: [OrderActor.RESTAURANT, OrderActor.ADMIN],
    },

    {from: OrderStatus.ASSIGNED, to: OrderStatus.PICKED, actors: [OrderActor.AGENT]},
    {from: OrderStatus.ASSIGNED, to: OrderStatus.CANCELLED, actors: [OrderActor.ADMIN]},
    // The unclaim: an agent hands an order back, or goes offline holding one,
    // and it returns to the pool for the next sweep to re-offer. This is the
    // only backwards edge in the machine, and it is deliberate — the
    // alternative is a `rejected`/`reassigned` state per attempt, which is
    // what the dropped `deliveries` table existed to record.
    //
    // Only from `assigned`: once the order is `picked` the food is in the
    // agent's bag, and handing it back is an exceptions flow, not this one.
    //
    // SYSTEM-only, like its mirror above, because the transition is never the
    // whole write: `delivery_agent_id` and `assigned_at` have to be cleared in
    // the same UPDATE. Reaching it through the generic PATCH /status would
    // move the status and leave the agent attached, so both edges are owned by
    // repository functions that write every column at once
    // (claimOrderForAgent / releaseOrderFromAgent).
    {
        from: OrderStatus.ASSIGNED,
        to: OrderStatus.READY,
        actors: [OrderActor.SYSTEM],
    },

    {from: OrderStatus.PICKED, to: OrderStatus.DELIVERED, actors: [OrderActor.AGENT]},
];

@injectable()
export class OrderStatusService {
    /**
     * Throws unless `from -> to` is a legal edge for this actor. Returns the
     * `<verb>_at` column the caller must stamp in the same update, so the
     * timestamp and the status can never disagree.
     */
    assertTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor): string | undefined {
        const edge = TRANSITIONS.find((t) => t.from === from && t.to === to);
        if (!edge) throw invalidStatusTransitionError(from, to);

        // An admin may traverse any edge that exists, but still cannot invent
        // one — the sequence stays monotonic (invariant 3).
        if (actor !== OrderActor.ADMIN && !edge.actors.includes(actor)) {
            throw invalidStatusTransitionError(from, to);
        }

        return STATUS_TIMESTAMP_COLUMN[to];
    }

    /** Rejections and cancellations must say why (contract s1.5). */
    assertReason(to: OrderStatus, reason: string | undefined): void {
        if (STATUSES_REQUIRING_REASON.has(to) && (!reason || reason.trim().length === 0)) {
            throw ReasonRequiredError;
        }
    }

    isTerminal(status: OrderStatus): boolean {
        return !TRANSITIONS.some((t) => t.from === status);
    }
}

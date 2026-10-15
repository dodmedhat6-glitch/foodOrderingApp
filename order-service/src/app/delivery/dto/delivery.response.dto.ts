import {OrderEntity} from "../../order/entity/order.entity";
import {OrderStatus} from "../../order/enums";
import {PaymentMethod} from "../../order/enums";

/**
 * Wire shapes for everything dispatch returns or broadcasts (CLAUDE.md s6).
 *
 * **There is no `deliveryId`.** A delivery is a phase of an order, so the
 * handle on the wire is the order's public UUID — the same id the customer and
 * the restaurant already use. That is the single most visible consequence of
 * dropping the `deliveries` table, and it is deliberate: one order, one id,
 * whoever is looking at it.
 *
 * Money is integer minor units next to a currency; timestamps are ISO-8601
 * UTC. The internal bigserial id, the region and the commission never cross
 * this boundary.
 */

/** Where the agent collects, from the branch projection. */
export interface PickupDTO {
    branchId: number;
    name: string;
    addressText: string;
    lat: number;
    lng: number;
}

/** Where the agent delivers, from the order's own snapshot. */
export interface DropoffDTO {
    addressText: string;
    lat: number;
    lng: number;
}

/**
 * What the agent's app renders — for an offer, for the claimed task, and for
 * the task list. One shape for all three because they are the same thing at
 * different moments, and an agent comparing an offer against what they got
 * should not have to reconcile two schemas.
 */
export class DeliveryTaskResponseDTO {
    orderPublicId!: string;
    status!: OrderStatus;
    pickup!: PickupDTO;
    dropoff!: DropoffDTO;
    itemsCount!: number;
    /**
     * What the customer owes. For COD this is what the agent collects on
     * handoff — which is why it is on the offer, not just on the task: an
     * agent may reasonably decline to carry a large cash order.
     */
    total!: number;
    currency!: string;
    paymentMethod!: PaymentMethod;
    /**
     * What this delivery is expected to pay. An estimate on an offer and on an
     * active task; the settled figure lives in `agent_earnings` and is what
     * `GET /agents/earnings` reports. They can differ if the rates change
     * between the offer and the handoff, which is why the earning is stamped
     * at settlement and never recomputed.
     */
    earningEstimate!: number;
    distanceMeters!: number;
    createdAt!: string;
    assignedAt?: string;
    pickedAt?: string;
    /** Offers only — when the client should stop showing this one. */
    expiresAt?: string;

    static from(
        order: OrderEntity,
        pickup: PickupDTO,
        itemsCount: number,
        earningEstimate: number,
        distanceMeters: number,
        expiresAt?: Date,
    ): DeliveryTaskResponseDTO {
        const dto = new DeliveryTaskResponseDTO();
        dto.orderPublicId = order.publicId;
        dto.status = order.status;
        dto.pickup = pickup;
        dto.dropoff = {
            addressText: order.deliveryAddressTextSnapshot,
            lat: order.deliveryLat,
            lng: order.deliveryLng,
        };
        dto.itemsCount = itemsCount;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.paymentMethod = order.paymentMethod;
        dto.earningEstimate = earningEstimate;
        dto.distanceMeters = distanceMeters;
        dto.createdAt = order.createdAt.toISOString();
        if (order.assignedAt) dto.assignedAt = order.assignedAt.toISOString();
        if (order.pickedAt) dto.pickedAt = order.pickedAt.toISOString();
        if (expiresAt) dto.expiresAt = expiresAt.toISOString();
        return dto;
    }
}

/**
 * The delivery block on `GET /api/orders/{publicId}` — what the *customer*
 * sees about who is bringing their food.
 *
 * `agent` carries `{ id, name }` and no phone: core's internal user lookup
 * returns `{ id, name, email }`, and an email is not something to hand a
 * customer. Adding a phone later is purely additive on both sides.
 */
export class DeliverySummaryResponseDTO {
    status!: OrderStatus;
    agent?: {id: number; name: string};
    assignedAt?: string;
    pickedAt?: string;
    deliveredAt?: string;

    static from(
        order: OrderEntity,
        agent?: {id: number; name: string},
    ): DeliverySummaryResponseDTO {
        const dto = new DeliverySummaryResponseDTO();
        dto.status = order.status;
        if (agent) dto.agent = agent;
        if (order.assignedAt) dto.assignedAt = order.assignedAt.toISOString();
        if (order.pickedAt) dto.pickedAt = order.pickedAt.toISOString();
        if (order.deliveredAt) dto.deliveredAt = order.deliveredAt.toISOString();
        return dto;
    }
}

/** `{ ok: true }` for the presence endpoints and the unclaim. */
export class AckResponseDTO {
    ok!: boolean;

    static ok(): AckResponseDTO {
        const dto = new AckResponseDTO();
        dto.ok = true;
        return dto;
    }
}

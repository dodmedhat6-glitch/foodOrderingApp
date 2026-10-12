import {SystemRole} from "../../lib/auth/roles";
import {OrderEntity} from "./entity/order.entity";
import {OrderActor} from "./enums";
import {OrderNotFoundError} from "./errors";
import {OrderRequester} from "./types";

/**
 * Who may see an order, and as which actor they move it. Plain functions with
 * no I/O: the answer depends on the order and the caller and nothing else.
 */

/**
 * Invariant 6 and 7 (docs/business-logic/orders.md s8): a customer can
 * only read their own order even holding its public id, and a restaurant
 * user only the branches they belong to — an owner gets the whole
 * restaurant.
 */
export function assertCanReadOrder(order: OrderEntity, requester: OrderRequester): void {
    if (requester.role === SystemRole.SYSTEM_ADMIN) return;

    if (requester.role === SystemRole.CUSTOMER) {
        if (order.customerId !== requester.userId) throw OrderNotFoundError;
        return;
    }

    if (requester.role === SystemRole.RESTAURANT_USER) {
        if (Number(requester.restaurantId) !== order.restaurantId) throw OrderNotFoundError;
        if (requester.restaurantRole === "owner") return;
        if (!(requester.branchIds ?? []).some((id) => Number(id) === order.branchId)) {
            throw OrderNotFoundError;
        }
        return;
    }

    if (requester.role === SystemRole.DELIVERY_AGENT) {
        if (order.deliveryAgentId !== requester.userId) throw OrderNotFoundError;
        return;
    }

    throw OrderNotFoundError;
}

/**
 * Maps the caller's system role onto the actor the status machine reasons
 * about. 404 rather than 403 for an unknown role: by this point the
 * caller has already been shown to have no legitimate view of the order,
 * and confirming it exists tells them something they shouldn't learn.
 */
export function resolveActor(requester: OrderRequester): OrderActor {
    switch (requester.role) {
        case SystemRole.SYSTEM_ADMIN:
            return OrderActor.ADMIN;
        case SystemRole.CUSTOMER:
            return OrderActor.CUSTOMER;
        case SystemRole.RESTAURANT_USER:
            return OrderActor.RESTAURANT;
        case SystemRole.DELIVERY_AGENT:
            return OrderActor.AGENT;
        default:
            throw OrderNotFoundError;
    }
}

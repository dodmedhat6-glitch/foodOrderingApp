import { injectable } from "tsyringe";
import { db } from "../../../lib/knex/kenx";
import { findBranchById } from "../../branch/repository/branch.repository";
import { findAddressById } from "../../addresses/repository/customer-address.repo";
import { findUserById } from "../../user/repository/user.repo";
import { findProductsByIdsAndBranch } from "../../product/repository/product.repository";
import {
    ReserveStockLine,
    ReservedLine,
    reserveBranchStock,
} from "../../product/repository/product-branch-details.repository";
import { findRestaurantById } from "../../restaurant/repository/restaurant.repo";
import { enqueueOutboxEvent } from "../../outbox/repository/outbox.repo";
import {
    buildInvalidationPayload,
    invalidationChannel,
    invalidationEventType,
} from "../../../lib/events/events";
import { BranchNotFoundError } from "../../branch/errors";
import { AddressNotFoundError } from "../../addresses/errors";
import { UserNotFound } from "../../user/errors";
import { AppError } from "../../../lib/error/AppError";

export interface BranchLookupResponse {
    id: number;
    restaurantId: number;
    restaurantName: string;
    restaurantStatus: string;
    countryCode: string;
    currency: string;
    name: string;
    addressText: string;
    lat: number;
    lng: number;
    isActive: boolean;
    acceptOrders: boolean;
    deliveryFeeMinor: number;
    commission: number;
}

export interface AddressLookupResponse {
    id: number;
    customerId: number;
    lat: number;
    lng: number;
    addressText: string;
}

export interface UserLookupResponse {
    id: number;
    name: string;
    email: string;
}

export interface ProductLookupResponse {
    id: number;
    branchId: number;
    name: string;
    imageUrl: string | null;
    unitPriceMinor: number;
    isAvailable: boolean;
    stock: number;
}

export interface ReserveStockResponse {
    reserved: ReservedLine[];
}

/**
 * Shapes core-service's own entities into the exact lookup contracts
 * order-service's core-client codes against - see order-service's
 * src/lib/core-client/types.ts. Keep these two shapes in lockstep; a mismatch
 * fails silently as an undefined field on order-service's side, not a type
 * error here.
 */
@injectable()
export class InternalService {
    /**
     * Everything order-service needs to price and authorise one checkout
     * against this branch: the trading flags it refuses an order on, the
     * delivery fee and commission it computes money with, and the
     * branch/restaurant names it snapshots onto the order row. One call per
     * placement, so the restaurant is joined here rather than left to a
     * second round trip.
     */
    getBranch = async (branchId: number): Promise<BranchLookupResponse> => {
        const branch = await findBranchById(branchId);
        if (!branch) {
            throw BranchNotFoundError;
        }

        const restaurant = await findRestaurantById(branch.restaurantId);

        return {
            id: branch.id,
            restaurantId: branch.restaurantId,
            restaurantName: restaurant?.name ?? "",
            restaurantStatus: restaurant?.status ?? "",
            countryCode: branch.countryCode,
            currency: branch.currency,
            name: branch.label,
            addressText: branch.addressText,
            lat: Number(branch.lat),
            lng: Number(branch.lng),
            isActive: branch.isActive,
            acceptOrders: branch.acceptOrders,
            deliveryFeeMinor: branch.deliveryFeeMinor,
            commission: branch.commission,
        };
    }

    getAddress = async (addressId: number): Promise<AddressLookupResponse> => {
        const address = await findAddressById(addressId);
        if (!address) {
            throw AddressNotFoundError;
        }
        const addressText = [address.building, address.street, address.city, address.country]
            .filter((part) => Boolean(part))
            .join(", ");
        return {
            id: address.id,
            customerId: address.userId,
            lat: address.lat,
            lng: address.lng,
            addressText,
        };
    }

    getUser = async (userId: number): Promise<UserLookupResponse> => {
        const user = await findUserById(userId);
        if (!user) {
            throw UserNotFound;
        }
        return {
            id: user.id,
            name: user.name,
            email: user.email,
        };
    }

    getProducts = async (productIds: number[], branchId: number): Promise<ProductLookupResponse[]> => {
        return await findProductsByIdsAndBranch(productIds, branchId);
    }

    /**
     * Holds the units an order-service order has already committed to. All or
     * nothing: if any line can't be covered the transaction rolls back and the
     * caller gets a 409 listing every offending line, which is what lets
     * order-service void the order and tell the customer exactly what to fix.
     *
     * The outbox row goes in the same transaction as the decrement, so
     * order-service's cached product projection is invalidated if and only if
     * the stock actually moved.
     */
    reserveStock = async (branchId: number, lines: ReserveStockLine[]): Promise<ReserveStockResponse> => {
        const branch = await findBranchById(branchId);
        if (!branch) {
            throw BranchNotFoundError;
        }

        const trx = await db.transaction();
        try {
            const { reserved, unavailable } = await reserveBranchStock(branchId, lines, trx);

            if (unavailable.length > 0) {
                await trx.rollback();
                throw new AppError("OutOfStock", 409, true, { details: unavailable });
            }

            for (const line of reserved) {
                await enqueueOutboxEvent({
                    channel: invalidationChannel("product"),
                    eventType: invalidationEventType("product"),
                    entityType: "product",
                    entityId: line.productId,
                    payload: buildInvalidationPayload(line.productId),
                }, trx);
            }

            await trx.commit();
            return { reserved };
        } catch (error) {
            if (!trx.isCompleted()) {
                await trx.rollback();
            }
            throw error;
        }
    }
}

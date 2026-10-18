import {UnAuthorisedError} from "../../../lib/auth/error";
import {RestaurantNotFoundError} from "../../restaurant/errors";
import {findRestaurantById} from "../../restaurant/repository/restaurant.repo";
import {BranchNotFoundError} from "../errors";
import {SystemRole} from "../../user/enums";
import {CreateBranchDTO, UpdateBranchDTO, UpdateBranchStatusDTO} from "../dto/branch.dto";
import {findNearbyBranches, createBranch, findBranchesByRestaurant, findBranchById, updateBranch, updateBranchStatus} from "../repository/branch.repository";
import {inject, injectable} from "tsyringe";
import {db} from "../../../lib/knex/kenx";
import {enqueueOutboxEvent} from "../../outbox/repository/outbox.repo";
import {buildBranchInvalidationPayload, invalidationChannel, invalidationEventType} from "../../../lib/events/events";
import {tokens} from "../../../lib/di/tokens";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {internalBranchLookupKey} from "../../../lib/cache/cache-keys";

@injectable()
export class BranchService {

    constructor(@inject(tokens.CacheProvider) private readonly cache: ICacheProvider) {
    }

    findNearby = async (lat:number, lng:number) => {
        const rows = await findNearbyBranches(lat, lng);
        return rows;
    }

    findByRestaurant = async (restaurantId: number) => {
        return await findBranchesByRestaurant(restaurantId);
    }

    create = async (restaurantId: number, userId: number, userRole: SystemRole, data: CreateBranchDTO) => {
        const restaurant = await findRestaurantById(restaurantId);
        if (!restaurant) throw RestaurantNotFoundError;

        if(userRole != SystemRole.SYSTEM_ADMIN && (Number(restaurant.ownerId) !== Number(userId)) ){
            throw UnAuthorisedError
        }

        const now = new Date();
        const branch = await createBranch({
            restaurantId: restaurantId,
            label: data.label,
            countryCode: data.countryCode,
            lat: data.lat,
            lng: data.lng,
            addressText: data.addressText,
            isActive: false,
            opensAt: data.opensAt,
            closesAt: data.closesAt,
            currency: data.currency,
            deliveryRadius: data.deliveryRadius,
            commission: 0,
            deliveryFeeMinor: data.deliveryFeeMinor ?? 0,
            createdAt: now,
            updatedAt: now,
            acceptOrders: true,
        });

        return branch;
    }

    update = async (branchId: number, userId: number, userRole: SystemRole, data: UpdateBranchDTO) => {
        const branch = await findBranchById(branchId);
        if (!branch) {
            throw BranchNotFoundError;
        }

        const restaurant = await findRestaurantById(branch.restaurantId);
        if (!restaurant) throw RestaurantNotFoundError;
        if (userRole !== SystemRole.SYSTEM_ADMIN && Number(restaurant.ownerId) !== Number(userId)) {
            throw UnAuthorisedError;
        }

        // acceptOrders is operational status order-service caches - see
        // this.updateStatus for why both writers go through the outbox.
        //
        // Every field this endpoint can touch (label, address, delivery fee,
        // currency) is part of the internal branch lookup, so this service's
        // own cache of it is dropped on both paths - not only the one that
        // publishes an event.
        if (data.acceptOrders === undefined) {
            const updated = await updateBranch(branchId, data);
            await this.forgetBranchLookup(branchId);
            return updated;
        }

        const trx = await db.transaction();
        let updated;
        try {
            updated = await updateBranch(branchId, data, trx);
            await enqueueOutboxEvent({
                channel: invalidationChannel("branch"),
                eventType: invalidationEventType("branch"),
                entityType: "branch",
                entityId: branchId,
                // The transaction has the new trading flags in hand, so they
                // ride along: order-service can patch its branch projection
                // instead of dropping it and re-reading on the next placement.
                payload: buildBranchInvalidationPayload(branchId, {
                    isActive: updated.isActive,
                    acceptOrders: updated.acceptOrders,
                }),
            }, trx);
            await trx.commit();
        } catch (error) {
            await trx.rollback();
            throw error;
        }

        await this.forgetBranchLookup(branchId);
        return updated;
    }

    updateStatus = async (branchId: number, userRole: SystemRole, data: UpdateBranchStatusDTO) => {
        if (userRole !== SystemRole.SYSTEM_ADMIN) {
            throw UnAuthorisedError;
        }

        const branch = await findBranchById(branchId);
        if (!branch) {
            throw BranchNotFoundError;
        }

        // isActive is operational status order-service caches
        // (cache:core:branch:{id}) - the write and the invalidation event
        // must commit together, or a branch core-service has just closed
        // can silently keep accepting orders on order-service's stale read.
        const trx = await db.transaction();
        let updated;
        try {
            updated = await updateBranchStatus(branchId, data, trx);
            if (data.isActive !== undefined) {
                await enqueueOutboxEvent({
                    channel: invalidationChannel("branch"),
                    eventType: invalidationEventType("branch"),
                    entityType: "branch",
                    entityId: branchId,
                    payload: buildBranchInvalidationPayload(branchId, {
                        isActive: updated.isActive,
                        acceptOrders: updated.acceptOrders,
                    }),
                }, trx);
            }
            await trx.commit();
        } catch (error) {
            await trx.rollback();
            throw error;
        }

        // Also on the commission-only path: commission is in the lookup too.
        await this.forgetBranchLookup(branchId);
        return updated;
    }

    /**
     * Drops this service's cached copy of the internal branch lookup
     * (lib/cache/cache-keys.ts). Best-effort and always *after* commit: a
     * Redis failure must not roll back a write that succeeded, and the
     * 300s TTL is the backstop. Deleting before the commit would be the
     * actually-wrong order - a concurrent read could repopulate the key from
     * the pre-commit row.
     */
    private forgetBranchLookup = async (branchId: number): Promise<void> => {
        await this.cache.del(internalBranchLookupKey(branchId)).catch(() => {});
    }
}

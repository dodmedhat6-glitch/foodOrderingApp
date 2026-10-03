import {UnAuthorisedError} from "../../../lib/auth/error";
import {RestaurantNotFoundError} from "../../restaurant/errors";
import {findRestaurantById} from "../../restaurant/repository/restaurant.repo";
import {BranchNotFoundError} from "../errors";
import {SystemRole} from "../../user/enums";
import {CreateBranchDTO, UpdateBranchDTO, UpdateBranchStatusDTO} from "../dto/branch.dto";
import {findNearbyBranches, createBranch, findBranchesByRestaurant, findBranchById, updateBranch, updateBranchStatus} from "../repository/branch.repository";
import {injectable} from "tsyringe";
import {db} from "../../../lib/knex/kenx";
import {enqueueOutboxEvent} from "../../outbox/repository/outbox.repo";
import {buildInvalidationPayload, invalidationChannel, invalidationEventType} from "../../../lib/events/events";

@injectable()
export class BranchService {

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
        if (data.acceptOrders === undefined) {
            return await updateBranch(branchId, data);
        }

        const trx = await db.transaction();
        try {
            const updated = await updateBranch(branchId, data, trx);
            await enqueueOutboxEvent({
                channel: invalidationChannel("branch"),
                eventType: invalidationEventType("branch"),
                entityType: "branch",
                entityId: branchId,
                payload: buildInvalidationPayload(branchId),
            }, trx);
            await trx.commit();
            return updated;
        } catch (error) {
            await trx.rollback();
            throw error;
        }
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
        try {
            const updated = await updateBranchStatus(branchId, data, trx);
            if (data.isActive !== undefined) {
                await enqueueOutboxEvent({
                    channel: invalidationChannel("branch"),
                    eventType: invalidationEventType("branch"),
                    entityType: "branch",
                    entityId: branchId,
                    payload: buildInvalidationPayload(branchId),
                }, trx);
            }
            await trx.commit();
            return updated;
        } catch (error) {
            await trx.rollback();
            throw error;
        }
    }
}

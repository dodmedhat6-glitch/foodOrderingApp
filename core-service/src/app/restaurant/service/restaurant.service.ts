import {RegisterRestaurantDto} from "../../auth/dto/auth.dto";
import {
    createRestaurant,
    findAllRestaurants,
    findRestaurantById,
    updateRestaurant, updateRestaurantStatus
} from "../repository/restaurant.repo";
import {RestaurantEntity} from "../entity/restaurant.entity";
import {RestaurantStatus} from "../enums";
import  {Knex} from "knex";
import {SystemRole} from "../../user/enums";
import {UpdateRestaurantDTO, UpdateRestaurantStatusDTO} from "../dto/restaurant.dto";
import {RestaurantNotFoundError} from "../errors";
import {UnAuthorisedError} from "../../../lib/auth/error";
import {inject, injectable} from "tsyringe";
import {buildPaginationResult, FilterParams, PaginationParams} from "../../../lib/http/pagination/cursor.pagination";
import {db} from "../../../lib/knex/kenx";
import {enqueueOutboxEvent} from "../../outbox/repository/outbox.repo";
import {buildInvalidationPayload, invalidationChannel, invalidationEventType} from "../../../lib/events/events";
import {tokens} from "../../../lib/di/tokens";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {internalBranchLookupKey} from "../../../lib/cache/cache-keys";
import {findBranchesByRestaurant} from "../../branch/repository/branch.repository";


@injectable()
export class RestaurantService{

    constructor(@inject(tokens.CacheProvider) private readonly cache: ICacheProvider) {
    }

    create = async (userId:number , data: RegisterRestaurantDto , trx:Knex) =>{
        const now = new Date();

         const restaurant = await createRestaurant( new RestaurantEntity({
            ownerId: userId,
            name : data.name,
            logoURL: data.logoURL,
            primaryCountry: data.primaryCountry,
            status: RestaurantStatus.PENDING,
            createdAt: now,
            updateAt: now,
            statusUpdatedAt: now
        }), trx);

        return restaurant;
    }

    findAll = async (params : PaginationParams , filters : FilterParams[]) =>{
        const result = await findAllRestaurants(params , filters);
        return buildPaginationResult(result, params.limit, params.sortBy)
    }

    update = async(id: number, userId: number, userRole: SystemRole, data: UpdateRestaurantDTO) => {
        const restaurant = await findRestaurantById(id);
        if (!restaurant) {
            throw RestaurantNotFoundError;
        }
        if (userRole !== SystemRole.SYSTEM_ADMIN && Number(restaurant.ownerId) !== Number(userId)) {
            throw UnAuthorisedError;
        }
        return await updateRestaurant(id, data);
    }

    updateStatus = async(id: number, userRole: SystemRole, data: UpdateRestaurantStatusDTO) => {
        if (userRole !== SystemRole.SYSTEM_ADMIN) {
            throw UnAuthorisedError;
        }
        const restaurant = await findRestaurantById(id);
        if (!restaurant) {
            throw RestaurantNotFoundError;
        }

        // restaurant operational status is cached by order-service
        // (cache:core:restaurant:{id}) - write + invalidation event commit
        // together via the outbox, same reasoning as branch.service.ts.
        const trx = await db.transaction();
        let updated;
        try {
            updated = await updateRestaurantStatus(id, data.status, trx);
            await enqueueOutboxEvent({
                channel: invalidationChannel("restaurant"),
                eventType: invalidationEventType("restaurant"),
                entityType: "restaurant",
                entityId: id,
                payload: buildInvalidationPayload(id),
            }, trx);
            await trx.commit();
        } catch (error) {
            await trx.rollback();
            throw error;
        }

        await this.forgetBranchLookups(id);
        return updated;
    }

    /**
     * The internal branch lookup joins this restaurant's status into every one
     * of its branches (internal.service.getBranch), so suspending a restaurant
     * has to drop all of them - otherwise order-service keeps reading an
     * `active` restaurant through a cached branch row for the full TTL and
     * keeps accepting orders for a suspended restaurant.
     *
     * Enumerated rather than pattern-deleted: a restaurant has a handful of
     * branches, and core's cache provider has no cursor-scan delete.
     */
    private forgetBranchLookups = async (restaurantId: number): Promise<void> => {
        try {
            const branches = await findBranchesByRestaurant(restaurantId);
            await Promise.all(
                branches.map((branch) => this.cache.del(internalBranchLookupKey(branch.id)))
            );
        } catch {
            // Best-effort after a committed write; the lookup TTL is the backstop.
        }
    }
}

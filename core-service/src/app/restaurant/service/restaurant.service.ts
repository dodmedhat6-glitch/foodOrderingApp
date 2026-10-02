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
import {injectable} from "tsyringe";
import {buildPaginationResult, FilterParams, PaginationParams} from "../../../lib/http/pagination/cursor.pagination";
import {db} from "../../../lib/knex/kenx";
import {enqueueOutboxEvent} from "../../outbox/repository/outbox.repo";
import {buildInvalidationPayload, invalidationChannel, invalidationEventType} from "../../../lib/events/events";


@injectable()
export class RestaurantService{

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
        try {
            const updated = await updateRestaurantStatus(id, data.status, trx);
            await enqueueOutboxEvent({
                channel: invalidationChannel("restaurant"),
                eventType: invalidationEventType("restaurant"),
                entityType: "restaurant",
                entityId: id,
                payload: buildInvalidationPayload(id),
            }, trx);
            await trx.commit();
            return updated;
        } catch (error) {
            await trx.rollback();
            throw error;
        }
    }
}

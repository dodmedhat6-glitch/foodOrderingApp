import {RegisterRestaurantDto} from "../../auth/dto/auth.dto";
import {createRestaurant, findAllRestaurants} from "../repository/restaurant.repo";
import {RestaurantEntity} from "../entity/restaurant.entity";
import {RestaurantStatus} from "../enums";
import  {Knex} from "knex";

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

    findAll = async () =>{
        const result = await findAllRestaurants();
        return result
    }
}

export const restaurantService = new RestaurantService()
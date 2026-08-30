import {createBranch, findNearbyBranches} from "../repository/branch.repo";
import {SystemRole} from "../../user/enums";
import {findRestaurantsById} from "../../restaurant/repository/restaurant.repo";
import {UnAuthorisedError} from "../../../common/auth/error";
import {CreateBranchDto} from "../dto/branch.dto";

export class BranchService{
    findNearby = async (lat: number , lng: number)=>{
        const rows = await findNearbyBranches(lat,lng)
        return rows;
    }

    create = async (restaurantId:number , userId: number , userRole : SystemRole , data: CreateBranchDto)=>{
        const restaurant = await findRestaurantsById(restaurantId)

        if (userRole != SystemRole.SYSTEM_ADMIN && (restaurant.ownerId == userId)){
            throw UnAuthorisedError
        }

        const now = new Date()
        const branch = await createBranch({
            restaurantId : restaurantId,
            label : data.label,
            countryCode: data.countryCode,
            lat: data.lat,
            lng: data.lng,
            addressText: data.addressText,
            isActive: false,
            opensAt: data.opensAt,
            closesAt: data.closeAt,
            currency: data.currency,
            deliveryRadius:data.deliveryRadius,
            commission:0,
            createdAt: now,
            updatedAt: now,
            acceptOrders: true,
        });
        return branch;
    }
}

export const branchService = new BranchService()
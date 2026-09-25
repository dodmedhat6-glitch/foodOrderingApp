import {RestaurantService} from "../service/restaurant.service";
import {NextFunction, Request , Response} from "express";
import {validateBody} from "../../../lib/validation/validate";
import {UpdateRestaurantDTO, UpdateRestaurantStatusDTO} from "../dto/restaurant.dto";
import {SystemRole} from "../../user/enums";
import {inject, injectable} from "tsyringe";
import {tokens} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";
import {parseFilters, parseQuery} from "../../../lib/http/pagination/parse.query";

@injectable()
export class RestaurantController{
    constructor(@inject(tokens.RestaurantService) private readonly restaurantService: RestaurantService) {
    }

    getAll = async (req: Request , res: Response , next : NextFunction)=>{
        try {
            const params = parseQuery(req.query);
            const filters = parseFilters(req.query, ['id', 'name', 'status']);

            const result = await  this.restaurantService.findAll(params , filters);
            sendSuccess(res, result)
        } catch (err) {
            next(err)
        }
    }

    update = async(req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(UpdateRestaurantDTO, req.body);
            const result = await this.restaurantService.update(Number(req.params.id), req.user?.user_id!, req.user?.role! as SystemRole, data);
            sendSuccess(res, {message: "Restaurant updated", restaurant: result});
        } catch (err) {
            next(err);
        }
    }

    updateStatus = async(req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(UpdateRestaurantStatusDTO, req.body);
            const result = await this.restaurantService.updateStatus(Number(req.params.id), req.user?.role! as SystemRole, data);
            sendSuccess(res, {message: "Status updated", restaurant: {id: result.id, status: result.status}});
        } catch (err) {
            next(err);
        }
    }


}
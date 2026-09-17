import {Router} from "express";
import {container} from "../../lib/di/containers";
import {tokens} from "../../lib/di/tokens";
import {RestaurantController} from "./controller/restaurant.controller";
import {authenticate} from "../../lib/auth/guard";
import {rbac, requireRestaurantMember} from "../../lib/auth/rbac";

export const restaurantRouter = Router()
const restaurantController = container.resolve<RestaurantController>(tokens.RestaurantController);

restaurantRouter.get('/' , restaurantController.getAll)
restaurantRouter.patch('/:id',
    authenticate,
    requireRestaurantMember('id'),
    rbac({resource:"core:restaurant", action:'update'}),
    restaurantController.update
);
restaurantRouter.patch('/:id/status', authenticate, restaurantController.updateStatus); // system_admin only, checked in service

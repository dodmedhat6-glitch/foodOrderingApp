import {Router} from "express";
import {restaurantController} from "./controller/restaurant.controller";

export const restaurantRouter = Router()

restaurantRouter.get('/' , restaurantController.getAll)
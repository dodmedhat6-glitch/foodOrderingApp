 import {Router} from "express";
 import {branchController} from "./controller/branch.controller";


export const branchRouter = Router()

 branchRouter.get('/branches/nearby', branchController.findNearby)
 branchRouter.get('/branches/:restaurantId', branchController.create)

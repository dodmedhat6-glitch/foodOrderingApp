import { Router } from "express";
import { healthRouter } from "./app/health/health.router.js";
import { authRouter } from './app/auth/routes.js'
import {userRouter} from "./app/user/routes";
import {restaurantRouter} from "./app/restaurant/routes";
import {branchRouter} from "./app/branch/routes";
import {rbacRouter} from "./app/rbac/routes";
export const router = Router();

router.use("/health", healthRouter)

router.use('/auth', authRouter)

router.use("/user" , userRouter)

router.use('/restaurant' , restaurantRouter)

router.use('/' , branchRouter)

router.use('/' , rbacRouter)
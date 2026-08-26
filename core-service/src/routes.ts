import { Router } from "express";
import { healthRouter } from "./app/health/health.router.js";
import { authRouter } from './app/auth/routes.js'
import {userRouter} from "./app/user/routes";
export const router = Router();

router.use("/health", healthRouter)

router.use('/auth', authRouter)

router.use("/user" , userRouter)
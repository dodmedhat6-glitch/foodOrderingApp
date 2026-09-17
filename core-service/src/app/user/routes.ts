import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {container} from "../../lib/di/containers";
import {tokens} from "../../lib/di/tokens";
import {UserController} from "./controller/user.controller";

export  const userRouter = Router()
const userController = container.resolve<UserController>(tokens.UserController);

userRouter.get('/me', authenticate , userController.getMe)

userRouter.patch('/update-user', authenticate , userController.updateMe)
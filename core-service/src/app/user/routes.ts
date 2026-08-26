import {Router} from "express";
import {authenticate} from "../../common/auth/guard";
import {userController} from "./controller/user.controller";

export  const userRouter = Router()

userRouter.get('/me', authenticate , userController.getMe)

userRouter.patch('/update-user', authenticate , userController.updateMe)
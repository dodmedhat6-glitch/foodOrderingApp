import { Router } from 'express'
import {container} from "../../lib/di/containers";
import {tokens} from "../../lib/di/tokens";
import {AuthController} from './controller/auth.controller';

export const authRouter = Router();
const authController = container.resolve<AuthController>(tokens.AuthController);

authRouter.post('/register', authController.register);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.reMakeAccessToken);
authRouter.post('/forget-password', authController.forgetPassword)
authRouter.post('/reset-password', authController.resetPassword)
authRouter.post('/accept-invite', authController.acceptInvite)

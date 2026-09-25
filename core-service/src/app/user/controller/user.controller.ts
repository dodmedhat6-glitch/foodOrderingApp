import { NextFunction, Request, Response } from "express"
import { UserService } from "../service/user.service"
import {inject, injectable} from "tsyringe";
import {tokens} from "../../../lib/di/tokens";
import {sendError, sendSuccess} from "../../../lib/http/response";

@injectable()
export class UserController {
    constructor(@inject(tokens.UserService) private readonly userService: UserService) { }

    getMe = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.user) {
                return sendError(res, "Unauthorized", 401)
            }

            const user = await this.userService.findByUserId(req.user.user_id)
            sendSuccess(res, user)

        }
        catch (err) {
            next(err)
        }
    }

    // TODO : UPDATE USER
    updateMe = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.user) {
                return sendError(res, "Unauthorized", 401)
            }

            await this.userService.updateUserFields(req.user.user_id , req.body)
            sendSuccess(res, {message: "User updated successfully"})

        }
        catch (err) {
            next(err)
        }
    }
}
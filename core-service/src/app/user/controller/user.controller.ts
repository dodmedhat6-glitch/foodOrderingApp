import { NextFunction, Request, Response } from "express"
import { UserService } from "../service/user.service"
import {inject, injectable} from "tsyringe";
import {tokens} from "../../../lib/di/tokens";

@injectable()
export class UserController {
    constructor(@inject(tokens.UserService) private readonly userService: UserService) { }

    getMe = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: "Unauthorized" })
            }

            const user = await this.userService.findByUserId(req.user.user_id)
            return res.status(200).json(user)

        }
        catch (err) {
            next(err)
        }
    }

    // TODO : UPDATE USER
    updateMe = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: "Unauthorized" })
            }

            await this.userService.updateUserFields(req.user.user_id , req.body)
            return res.status(200).json({message : 'User updated successfully'})

        }
        catch (err) {
            next(err)
        }
    }
}
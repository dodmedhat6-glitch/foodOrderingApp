import { AuthService } from "../service/auth.service"
import { Request, Response, NextFunction } from "express"
import { LoginDto, RegisterDto, PasswordForgetDto, ResetPasswordDto } from "../dto/auth.dto"
import { validateBody } from "../../../lib/validation/validate"
import { setAuthCookies } from "../../../lib/auth/guard"
import { NotAuthenticated } from "../../../lib/auth/error"
import {inject, injectable} from "tsyringe";
import {tokens} from "../../../lib/di/tokens";

@injectable()
export class AuthController {

    constructor(@inject(tokens.AuthService) private readonly authService: AuthService) {

    }


    register = async (req: Request, res: Response, next: NextFunction) => {
        try {
            //1.validate req.body
            const data = await validateBody(RegisterDto, req.body);
            //2.call service 
            const result = await this.authService.register(data);
            setAuthCookies(res, result.accessToken, result.refreshToken);

            //3.respond
            res.status(201).json(result);

        } catch (err) {
            next(err);
        }
    }


    login = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(LoginDto, req.body)
            const result = await this.authService.login(data)

            setAuthCookies(res, result.accessToken, result.refreshToken);

            res.status(200).json(result)
        }
        catch (err) {
            next(err)
        }
    }

    forgetPassword = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(PasswordForgetDto, req.body);
            await this.authService.forgetPassword(data)
            res.status(200).json({
                "message": "Email sent with otp"
            })
        }
        catch (err) {
            next(err)
        }
    }

    resetPassword = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(ResetPasswordDto, req.body);
            await this.authService.resetPassword(data)
            res.status(200).json({
                "message": "password reset successfully, please login again"
            })
        }
        catch (err) {
            next(err)
        }
    }

    reMakeAccessToken = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const token = req.cookies.refresh_token;
            if (!token) {
                throw NotAuthenticated
            }

            const result = await this.authService.refreshToken(token);
            setAuthCookies(res, result.accessToken, result.refreshToken);

            res.status(200).json(result)
        }
        catch (err) {
            next(err)
        }
    }

    acceptInvite = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(ResetPasswordDto, req.body);
            await this.authService.acceptInvite(data)
            res.status(200).json({
                "message": "invitation accepted successfully , please login "
            })
        }
        catch (err) {
            next(err)
        }
    }

}

import {NextFunction, Request, Response} from "express";
import {CustomerAddressService} from "../service/customer-address.service";
import {validateBody} from "../../../lib/validation/validate";
import {CreateAddressDTO, UpdateAddressDTO} from "../dto/customer-address.dto";
import {inject, injectable} from "tsyringe";
import {tokens} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";

@injectable()
export class CustomerAddressController {
    constructor(@inject(tokens.CustomerAddressService) private readonly customerAddressService: CustomerAddressService) {}

    getAll = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const addresses = await this.customerAddressService.getByUserId(req.user?.user_id!);
            sendSuccess(res, addresses);
        } catch (err) {
            next(err);
        }
    }

    create = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(CreateAddressDTO, req.body);
            const address = await this.customerAddressService.create(req.user?.user_id!, data);
            sendSuccess(res, {message: "Address added", address}, 201);
        } catch (err) {
            next(err);
        }
    }

    update = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const addressId = Number(req.params.addressId);
            const data = await validateBody(UpdateAddressDTO, req.body);
            const address = await this.customerAddressService.update(req.user?.user_id!, addressId, data);
            sendSuccess(res, {message: "Address updated", address});
        } catch (err) {
            next(err);
        }
    }

    remove = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const addressId = Number(req.params.addressId);
            await this.customerAddressService.remove(req.user?.user_id!, addressId);
            sendSuccess(res, {message: "Address deleted"});
        } catch (err) {
            next(err);
        }
    }
}

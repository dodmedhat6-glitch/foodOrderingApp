import {NextFunction, Request, Response} from "express";
import {CustomerAddressService, customerAddressService} from "../service/customer-address.service";
import {validateBody} from "../../../common/validation/validate";
import {CreateAddressDTO, UpdateAddressDTO} from "../dto/customer-address.dto";

export class CustomerAddressController {
    constructor(private readonly customerAddressService: CustomerAddressService) {}

    getAll = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const addresses = await this.customerAddressService.getByUserId(req.user?.user_id!);
            res.status(200).json({data: addresses});
        } catch (err) {
            next(err);
        }
    }

    create = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(CreateAddressDTO, req.body);
            const address = await this.customerAddressService.create(req.user?.user_id!, data);
            res.status(201).json({message: "Address added", address});
        } catch (err) {
            next(err);
        }
    }

    update = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const addressId = Number(req.params.addressId);
            const data = await validateBody(UpdateAddressDTO, req.body);
            const address = await this.customerAddressService.update(req.user?.user_id!, addressId, data);
            res.status(200).json({message: "Address updated", address});
        } catch (err) {
            next(err);
        }
    }

    remove = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const addressId = Number(req.params.addressId);
            await this.customerAddressService.remove(req.user?.user_id!, addressId);
            res.status(200).json({message: "Address deleted"});
        } catch (err) {
            next(err);
        }
    }
}

export const customerAddressController = new CustomerAddressController(customerAddressService);

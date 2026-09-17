import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {container} from "../../lib/di/containers";
import {tokens} from "../../lib/di/tokens";
import {CustomerAddressController} from "./controller/customer-address.controller";

export const customerAddressRouter = Router();
const customerAddressController = container.resolve<CustomerAddressController>(tokens.CustomerAddressController);

customerAddressRouter.get('/', authenticate, customerAddressController.getAll);
customerAddressRouter.post('/', authenticate, customerAddressController.create);
customerAddressRouter.patch('/:addressId', authenticate, customerAddressController.update);
customerAddressRouter.delete('/:addressId', authenticate, customerAddressController.remove);

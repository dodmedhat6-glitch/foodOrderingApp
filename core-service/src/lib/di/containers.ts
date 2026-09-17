import { container } from "tsyringe";
import { tokens } from "./tokens";
import { AuthService } from "../../app/auth/service/auth.service";
import { AuthController } from "../../app/auth/controller/auth.controller";
import { UserService } from "../../app/user/service/user.service";
import { UserController } from "../../app/user/controller/user.controller";
import { RestaurantService } from "../../app/restaurant/service/restaurant.service";
import { RestaurantController } from "../../app/restaurant/controller/restaurant.controller";
import { BranchService } from "../../app/branch/service/branch.service";
import { BranchController } from "../../app/branch/controller/branch.controller";
import { MemberService } from "../../app/rbac/service/member.service";
import { MemberController } from "../../app/rbac/controller/member.controller";
import { ProductService } from "../../app/product/service/product.service";
import { ProductController } from "../../app/product/controller/product.controller";
import { CustomerAddressService } from "../../app/addresses/service/customer-address.service";
import { CustomerAddressController } from "../../app/addresses/controller/customer-address.controller";
import { PermissionsCashService } from "../../app/rbac/service/permissions-cash.service";
import { Logger } from "../logger/logger";

container.registerSingleton(tokens.AuthService, AuthService);
container.registerSingleton(tokens.AuthController, AuthController);

container.registerSingleton(tokens.UserService, UserService);
container.registerSingleton(tokens.UserController, UserController);

container.registerSingleton(tokens.RestaurantService, RestaurantService);
container.registerSingleton(tokens.RestaurantController, RestaurantController);

container.registerSingleton(tokens.BranchService, BranchService);
container.registerSingleton(tokens.BranchController, BranchController);

container.registerSingleton(tokens.MemberService, MemberService);
container.registerSingleton(tokens.MemberController, MemberController);

container.registerSingleton(tokens.ProductService, ProductService);
container.registerSingleton(tokens.ProductController, ProductController);

container.registerSingleton(tokens.CustomerAddressService, CustomerAddressService);
container.registerSingleton(tokens.CustomerAddressController, CustomerAddressController);

container.registerSingleton(tokens.PermissionCashService, PermissionsCashService);
container.registerSingleton(tokens.Logger, Logger);

export { container };


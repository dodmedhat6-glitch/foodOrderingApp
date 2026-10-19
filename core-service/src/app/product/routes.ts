import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {container} from "../../lib/di/containers";
import {tokens} from "../../lib/di/tokens";
import {ProductController} from "./controller/product.controller";
import {rbac, requireBranchAccess, requireRestaurantMember} from "../../lib/auth/rbac";

export const productRouter = Router();
const productController = container.resolve<ProductController>(tokens.ProductController);

// public storefront surface - intentionally unauthenticated, readable by branch/product id alone.
// branchId is globally unique, so the branch determines its restaurant and these results are single-restaurant by construction.
productRouter.get('/restaurants/:restaurantId/categories', productController.findCategories);
productRouter.get('/branches/:branchId/products', productController.findByBranch);
productRouter.get('/products/:id', productController.findById);

productRouter.get('/restaurants/:restaurantId/products',
    authenticate,
    requireRestaurantMember('restaurantId'),
    rbac({resource:"core:product", action:'read'}),
    productController.findByRestaurant
);
productRouter.post('/restaurants/:restaurantId/products',
    authenticate,
    requireRestaurantMember('restaurantId'),
    rbac({resource:"core:product", action:'create'}),
    productController.create
);
// Product-level fields (name, description, image, category). No branch in the
// path, so no requireBranchAccess - it would 400 every call. Ownership of the
// product's restaurant is checked in ProductService.update.
productRouter.patch('/products/:id',
    authenticate,
    rbac({resource:"core:product", action:'update'}),
    productController.update
);
// Per-branch price / stock / availability, scoped to a branch the caller can access.
productRouter.patch('/branches/:branchId/products/:id',
    authenticate,
    requireBranchAccess('branchId'),
    rbac({resource:"core:product", action:'update'}),
    productController.update
);

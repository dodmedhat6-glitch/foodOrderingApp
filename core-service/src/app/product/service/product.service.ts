import {UnAuthorisedError} from "../../../lib/auth/error";
import {RestaurantNotFoundError} from "../../restaurant/errors";
import {findRestaurantById} from "../../restaurant/repository/restaurant.repo";
import {ProductNotFoundError} from "../errors";
import {SystemRole} from "../../user/enums";
import {CreateProductDTO, UpdateProductDTO} from "../dto/product.dto";
import {createProduct, findProductById, findProductsByBranch, findProductsByRestaurant, updateProduct} from "../repository/product.repository";
import {findCategoryByName, findCategoriesByRestaurant, createCategory} from "../repository/category.repository";
import {updateBranchDetails} from "../repository/product-branch-details.repository";
import {injectable} from "tsyringe";
import {db} from "../../../lib/knex/kenx";
import {enqueueOutboxEvent} from "../../outbox/repository/outbox.repo";
import {buildInvalidationPayload, invalidationChannel, invalidationEventType} from "../../../lib/events/events";

@injectable()
export class ProductService {

    create = async (restaurantId: number, userId: number, userRole: SystemRole, data: CreateProductDTO) => {
        const restaurant = await findRestaurantById(restaurantId);
        if (!restaurant) throw RestaurantNotFoundError;
        if (userRole !== SystemRole.SYSTEM_ADMIN && Number(restaurant.ownerId) !== Number(userId)) {
            throw UnAuthorisedError;
        }

        let categoryId: number | null = null;
        if (data.categoryName) {
            let category = await findCategoryByName(restaurantId, data.categoryName);
            if (!category) {
                category = await createCategory(restaurantId, data.categoryName);
            }
            categoryId = category.id;
        }

        return await createProduct({
            name: data.name,
            description: data.description,
            imageUrl: data.imageUrl,
            restaurantId,
            categoryId,
        });
    }

    findByRestaurant = async (restaurantId: number, userId: number, userRole: SystemRole) => {
        const restaurant = await findRestaurantById(restaurantId);
        if (!restaurant) throw RestaurantNotFoundError;
        if (userRole !== SystemRole.SYSTEM_ADMIN && Number(restaurant.ownerId) !== Number(userId)) {
            throw UnAuthorisedError;
        }
        return await findProductsByRestaurant(restaurantId);
    }

    findCategories = async (restaurantId: number) => {
        return await findCategoriesByRestaurant(restaurantId);
    }

    findByBranch = async (branchId: number) => {
        return await findProductsByBranch(branchId);
    }

    findById = async (id: number) => {
        const product = await findProductById(id);
        if (!product) {
            throw ProductNotFoundError;
        }
        return product;
    }

    update = async (productId: number, userId: number, userRole: SystemRole, data: UpdateProductDTO, branchId?: number) => {
        const product = await findProductById(productId);
        if (!product) {
            throw ProductNotFoundError;
        }

        const restaurant = await findRestaurantById(product.restaurantId);
        if (!restaurant) throw RestaurantNotFoundError;
        if (userRole !== SystemRole.SYSTEM_ADMIN && Number(restaurant.ownerId) !== Number(userId)) {
            throw UnAuthorisedError;
        }

        let categoryId: number | undefined = undefined;
        if (data.categoryName) {
            let category = await findCategoryByName(product.restaurantId, data.categoryName);
            if (!category) {
                category = await createCategory(product.restaurantId, data.categoryName);
            }
            categoryId = category.id;
        }

        const hasBranchDetailsChange = Boolean(branchId) && (data.price !== undefined || data.stock !== undefined || data.isAvailable !== undefined);

        const trx = await db.transaction();
        let updatedProduct;
        let branchDetails;
        try {
            updatedProduct = await updateProduct(productId, {
                name: data.name,
                description: data.description,
                imageUrl: data.imageUrl,
                categoryId,
            }, trx);

            if (hasBranchDetailsChange) {
                branchDetails = await updateBranchDetails(branchId!, productId, {
                    price: data.price,
                    stock: data.stock,
                    isAvailable: data.isAvailable,
                }, trx);

                // order-service caches product price/stock/isAvailable
                // (cache:core:product:{id}) and must invalidate on this exact
                // write - see docs/01-system-design.md §5.1 on the order-service side.
                await enqueueOutboxEvent({
                    channel: invalidationChannel("product"),
                    eventType: invalidationEventType("product"),
                    entityType: "product",
                    entityId: productId,
                    payload: buildInvalidationPayload(productId),
                }, trx);
            }

            await trx.commit();
        } catch (error) {
            await trx.rollback();
            throw error;
        }

        return {product: updatedProduct, branchDetails};
    }
}

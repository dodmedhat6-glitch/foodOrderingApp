import {container} from "../../di/container";
import {TOKENS} from "../../di/tokens";
import {CoreProjectionService} from "../../core-client/projection.service";
import {CoreEventType} from "../event-types";
import {CoreEventHandler} from "../types";
import {entityId, productFields} from "./payload";

/**
 * `core.product.invalidated` — a branch product's price, stock or availability
 * changed. The highest-volume inbound event by a wide margin: core publishes
 * one per line of every order placed anywhere, because reserving stock is a
 * write.
 */
export const handleProductInvalidated: CoreEventHandler = async (payload) => {
    const productId = entityId(payload, CoreEventType.PRODUCT_INVALIDATED);
    await projections().applyProductChange(productId, productFields(payload));
};

function projections(): CoreProjectionService {
    return container.resolve<CoreProjectionService>(TOKENS.CoreProjectionService);
}

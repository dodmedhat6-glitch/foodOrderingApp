import {container} from "../../di/container";
import {TOKENS} from "../../di/tokens";
import {CoreProjectionService} from "../../core-client/projection.service";
import {CoreEventType} from "../event-types";
import {CoreEventHandler} from "../types";
import {entityId} from "./payload";

/**
 * `core.restaurant.invalidated` — a restaurant's row changed, most
 * consequentially its trading status. Nothing to patch here: that status
 * reaches us only inside the branch projection, and the event does not carry
 * it.
 */
export const handleRestaurantInvalidated: CoreEventHandler = async (payload) => {
    const restaurantId = entityId(payload, CoreEventType.RESTAURANT_INVALIDATED);
    await projections().invalidateRestaurant(restaurantId);
};

function projections(): CoreProjectionService {
    return container.resolve<CoreProjectionService>(TOKENS.CoreProjectionService);
}

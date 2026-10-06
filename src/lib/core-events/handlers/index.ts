import {registerHandler, resetHandlers} from "../registry";
import {CoreEventType} from "../event-types";
import {handleBranchInvalidated} from "./branch.handler";
import {handleProductInvalidated} from "./product.handler";
import {handleRestaurantInvalidated} from "./restaurant.handler";
import {handleIgnoredEvent} from "./identity.handler";

export {CoreEventType} from "../event-types";

/**
 * Wires core's event catalog to its handlers. Called once at boot, before
 * anything consumes, so a message arriving in the first milliseconds of the
 * connection finds its handler instead of being acked as unhandled.
 *
 * The handlers are thin wrappers — parse, delegate — and every one of them
 * delegates to `CoreProjectionService` today. That is a property of this
 * milestone (every inbound event is a cache correction), not of the design: a
 * handler that needs a database write, a second upstream call or a WebSocket
 * broadcast delegates to whichever service owns that domain, and only this
 * file changes.
 */
export function registerCoreEventHandlers(options: {reset?: boolean} = {}): void {
    if (options.reset) resetHandlers();

    registerHandler(CoreEventType.BRANCH_INVALIDATED, handleBranchInvalidated);
    registerHandler(CoreEventType.PRODUCT_INVALIDATED, handleProductInvalidated);
    registerHandler(CoreEventType.RESTAURANT_INVALIDATED, handleRestaurantInvalidated);
    registerHandler(CoreEventType.ADDRESS_INVALIDATED, handleIgnoredEvent);
    registerHandler(CoreEventType.USER_INVALIDATED, handleIgnoredEvent);
}

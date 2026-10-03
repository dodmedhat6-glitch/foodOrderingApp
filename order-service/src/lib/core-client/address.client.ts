import {coreClient} from "./core-client";
import {AddressLookup, CoreCallContext} from "./types";

/**
 * Not cached: an address is read once per order placement, and we immediately
 * snapshot lat/lng/text onto the order row. A stale projection here would mean
 * delivering to the wrong place, which is the one failure mode worth a
 * round-trip every time.
 */
export async function getCustomerAddress(
    addressId: number,
    ctx: CoreCallContext = {},
): Promise<AddressLookup> {
    return coreClient.call<AddressLookup>({
        method: "GET",
        path: `/api/internal/addresses/${addressId}`,
        correlationId: ctx.correlationId,
    });
}

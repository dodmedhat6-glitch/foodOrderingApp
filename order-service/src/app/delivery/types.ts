import {OrderEntity} from "../order/entity/order.entity";
import {BranchLookup} from "../../lib/core-client/types";

/**
 * Module-level helper shapes shared between the services and the controller,
 * so none of those files declares an inline interface (CLAUDE.md s5.10).
 */

/** An order paired with the branch projection dispatch needs to price and locate it. */
export interface OrderWithBranch {
    order: OrderEntity;
    branch: BranchLookup;
}

/** What one offer round decided, for the sweep's logs and its attempt counter. */
export interface OfferOutcome {
    orderPublicId: string;
    candidates: number;
    radiusMeters: number;
    attempt: number;
    stalled: boolean;
}

/** The authenticated agent acting on an order. */
export interface AgentActor {
    agentId: number;
    region: string;
}

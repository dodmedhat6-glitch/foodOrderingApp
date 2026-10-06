import {container} from "../../di/container";
import {TOKENS} from "../../di/tokens";
import {CoreProjectionService} from "../../core-client/projection.service";
import {CoreEventType} from "../event-types";
import {CoreEventHandler} from "../types";
import {branchFlags, entityId} from "./payload";

/**
 * `core.branch.invalidated` — a branch's row changed in core.
 *
 * Thin by design (CLAUDE.md s10, the same rule controllers follow): parse the
 * payload, hand typed values to the service, nothing else. The service is
 * resolved per call rather than at module load, so that handler registration —
 * which happens first thing in server.ts, before the WS server is even in the
 * container — never depends on what is wired yet.
 */
export const handleBranchInvalidated: CoreEventHandler = async (payload) => {
    const branchId = entityId(payload, CoreEventType.BRANCH_INVALIDATED);
    await projections().applyBranchChange(branchId, branchFlags(payload));
};

function projections(): CoreProjectionService {
    return container.resolve<CoreProjectionService>(TOKENS.CoreProjectionService);
}

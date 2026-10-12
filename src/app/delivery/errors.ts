import {AppError} from "../../lib/error/AppError";

/**
 * Canonical dispatch errors. Wording and status codes are part of the contract
 * (docs/api-contracts.md s3), so services throw these instances rather than
 * constructing ad-hoc AppErrors.
 */

/**
 * The claim was lost. **Not a failure** — several agents are offered the same
 * order on purpose and all but one must lose, so this is the ordinary outcome
 * of a race the client should expect and handle by clearing the offer.
 */
export const OrderAlreadyAssignedError = new AppError("OrderAlreadyAssigned", 409);

/** The order is not in `ready`, so there is nothing to claim. */
export const OrderNotReadyError = new AppError("OrderNotReady", 409);

/** The caller is not the agent this order is assigned to. */
export const NotYourDeliveryError = new AppError("NotYourDelivery", 403);

/**
 * 403 rather than 404 on purpose: the agent was told this order exists by an
 * offer, so acknowledging it is not a leak. Contrast `OrderNotFound`, which
 * the order module returns to a customer probing somebody else's id.
 */
export const AgentInActiveDeliveryError = new AppError("AgentInActiveDelivery", 409);

/** The food is already in the agent's bag; handing it back is an exceptions flow. */
export const CannotUnclaimAfterPickupError = new AppError("CannotUnclaimAfterPickup", 409);

/** The agent has no live presence entry, so they cannot be given work. */
export const NotOnlineError = new AppError("NotOnline", 409);

/** Admin force-assign named an agent core does not know. */
export const AgentNotFoundError = new AppError("AgentNotFound", 404);

/** Dispatch has offered this order its full quota of rounds. */
export const MaxAssignmentAttemptsReachedError = new AppError("MaxAssignmentAttemptsReached", 409);

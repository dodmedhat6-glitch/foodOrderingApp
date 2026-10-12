import {IsInt, Min} from "class-validator";

/**
 * Body of `POST /api/orders/{publicId}/assign` — the admin override that
 * bypasses the offer round and hands an order to a named agent.
 *
 * The agent is named here and nowhere else: on `/claim` the agent is the JWT
 * subject, never a body field, so an agent cannot claim work on somebody
 * else's behalf.
 */
export class AssignDeliveryRequestDTO {
    @IsInt()
    @Min(1)
    agentId!: number;
}

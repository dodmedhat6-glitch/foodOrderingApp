/**
 * The `agent_earnings` row. Plain class from `Partial`, no decorators, no DB
 * knowledge (CLAUDE.md s5.1).
 *
 * `amount` is integer minor units and is a *stamp*, not a derivation: it was
 * computed once, at settlement, from the rates in force then. Nothing
 * recomputes it, which is why there is no rate on the entity to recompute
 * from.
 *
 * `orderPublicId` is denormalised from `orders` so an earnings page never has
 * to reach back into a partitioned table it would have to fan out across —
 * and so it keeps resolving after archival moves those rows to the cold
 * cluster.
 */
export class AgentEarningEntity {
    id: number;
    region: string;
    agentId: number;
    orderId: number;
    orderPublicId: string;
    amount: number;
    currency: string;
    distanceMeters: number | null;
    earnedAt: Date;

    constructor(data: Partial<AgentEarningEntity>) {
        this.id = data.id!;
        this.region = data.region!;
        this.agentId = data.agentId!;
        this.orderId = data.orderId!;
        this.orderPublicId = data.orderPublicId!;
        this.amount = data.amount!;
        this.currency = data.currency!;
        this.distanceMeters = data.distanceMeters ?? null;
        this.earnedAt = data.earnedAt!;
    }
}

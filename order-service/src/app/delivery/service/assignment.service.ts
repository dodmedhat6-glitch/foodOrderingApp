import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {env} from "../../../lib/config/env";
import {logger} from "../../../lib/logger/logger";
import {db} from "../../../lib/knex/knex";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {haversineMeters} from "../../../pkg/utils/geo";
import {toMs} from "../../../pkg/utils/time";
import {getBranches} from "../../../lib/core-client/branch.client";
import {BranchLookup} from "../../../lib/core-client/types";
import {wsChannels, wsPublish} from "../../../lib/websocket/publisher";
import {OrderEntity} from "../../order/entity/order.entity";
import {OrderStatus} from "../../order/enums";
import {OrderDispatchService} from "../../order/service/order-dispatch.service";
import {countItemsByOrderIds} from "../../order/repository/order-item.repo";
import {PresenceService} from "../../agent/service/presence.service";
import {DeliveryTaskResponseDTO, PickupDTO} from "../dto/delivery.response.dto";
import {DeliveryWsEvent} from "../enums";
import {OfferOutcome} from "../types";

/**
 * Dispatch: deciding which agents hear about an order, and when to give up.
 *
 * **Offer to the K nearest, first claim wins.** Nothing here assigns anything
 * — it broadcasts, and the claim (delivery.service, over a conditional UPDATE)
 * decides. That is the whole reason this service holds no locks, keeps no
 * pending-offer rows, and needs no accept timeout: there is no state to clean
 * up when an offer goes unanswered, because an offer is just a message.
 *
 * The alternative shape — assign one agent, wait 30s for an accept, mark them
 * rejected, try the next — costs up to three sequential windows before the
 * third agent hears anything, and needs a durable row per attempt purely to
 * hold the pending offer. That row is what the dropped `deliveries` table
 * mostly existed for.
 *
 * **Dispatch opens at `preparing`, not `ready`.** The agent's drive to the
 * branch overlaps the cooking instead of following it, so the food waits for
 * the courier less often than the other way round. An agent who claims early
 * holds a `preparing` order; it becomes `assigned` when the kitchen marks it
 * `ready` (order.service.writeReady).
 *
 * **The sweep is the entry point, not a hook on a transition.** A post-commit
 * hook fires once, at the instant a human presses a button; if no agent is
 * online right then, the order would sit unclaimed forever. The `preparing`
 * and `ready` hooks only nudge this awake to keep the common case sub-second
 * — correctness is the sweep's.
 */
@injectable()
export class AssignmentService {
    constructor(
        @inject(TOKENS.OrderDispatchService) private readonly orders: OrderDispatchService,
        @inject(TOKENS.PresenceService) private readonly presence: PresenceService,
        @inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider,
    ) {}

    /**
     * One pass over a region: find `preparing` and `ready` orders nobody has
     * claimed, and offer each to its nearest candidates.
     *
     * Branch projections for the whole batch are fetched with one `getMany`
     * (`getBranches`), not one `get` per order — a per-key cache read in a
     * loop is the read-side N+1 and costs one network latency per order
     * (CLAUDE.md s8).
     */
    sweepRegion = async (region: string): Promise<OfferOutcome[]> => {
        const orders = await this.orders.findUnclaimedDispatchable(region, SWEEP_BATCH);
        if (orders.length === 0) return [];

        const branches = await getBranches(orders.map((order) => order.branchId));
        const counts = await countItemsByOrderIds(
            orders.map((order) => order.id),
            db(region),
        );
        const countByOrderId = new Map(counts.map((c) => [c.orderId, c.count]));

        const outcomes: OfferOutcome[] = [];
        for (const order of orders) {
            const branch = branches.get(order.branchId);
            if (!branch) {
                // Undispatchable, not lost: without the branch's coordinates
                // there is no point to search from. The next sweep retries,
                // by which time the projection has very likely refilled.
                logger.warn("skipping offer; branch projection unavailable", {
                    orderPublicId: order.publicId,
                    branchId: order.branchId,
                });
                continue;
            }

            try {
                outcomes.push(
                    await this.offer(order, branch, countByOrderId.get(order.id) ?? 0),
                );
            } catch (err) {
                // One order's failure must not end the pass — the others are
                // waiting on the same sweep.
                logger.error("offer failed", {
                    orderPublicId: order.publicId,
                    error: (err as Error).message,
                });
            }
        }
        return outcomes;
    };

    /**
     * Offers one order to its nearest candidates.
     *
     * The radius widens with each round (`ASSIGNMENT_RADIUS_ESCALATION`, up to
     * `ASSIGNMENT_RADIUS_MAX_METERS`) because the reason nobody claimed round
     * one is usually that nobody was close enough. After
     * `MAX_ASSIGNMENT_ATTEMPTS` rounds the order is declared stalled: an admin
     * is told and **the order stays `ready`**. A stalled order is a visible
     * order someone can act on; auto-cancelling it would destroy a paid order
     * because our dispatch could not find a courier, which is our problem and
     * not the customer's.
     *
     * A `preparing` order never stalls. Nobody being free yet while the food
     * is still cooking is normal, not an incident; it keeps being offered at
     * the widest radius instead, and gets a fresh set of rounds when it
     * reaches `ready` (DeliveryService.nudgeDispatch).
     */
    offer = async (
        order: OrderEntity,
        branch: BranchLookup,
        itemsCount: number,
    ): Promise<OfferOutcome> => {
        const attempt = await this.nextAttempt(order.publicId);
        const radiusMeters = this.radiusFor(attempt);

        if (attempt > env.dispatch.maxAttempts && order.status !== OrderStatus.PREPARING) {
            this.publishStalled(order, attempt);
            return {
                orderPublicId: order.publicId,
                candidates: 0,
                radiusMeters,
                attempt,
                stalled: true,
            };
        }

        const candidates = await this.presence.findCandidates(
            order.region,
            branch.lat,
            branch.lng,
            radiusMeters,
            env.dispatch.candidates,
        );

        if (candidates.length > 0) {
            const task = this.buildTask(
                order,
                branch,
                itemsCount,
                new Date(Date.now() + toMs(env.dispatch.offerTtlSec, "s")),
            );
            const offered = candidates.map((candidate) => candidate.memberId);
            // Remembered only so the losers can be told the moment somebody
            // wins, instead of finding out by claiming and getting a 409. It
            // expires with the offer round: this is a courtesy to clients, not
            // state anything depends on, and the claim is correct whether or
            // not it survives.
            await this.rememberOffer(order.publicId, offered);
            wsPublish(offered.map(wsChannels.agent), DeliveryWsEvent.OFFERED, task);
        }

        logger.info("order offered", {
            orderPublicId: order.publicId,
            region: order.region,
            attempt,
            radiusMeters,
            candidates: candidates.length,
        });

        return {
            orderPublicId: order.publicId,
            candidates: candidates.length,
            radiusMeters,
            attempt,
            stalled: false,
        };
    };

    /**
     * Builds the agent-facing view of an order: pickup from the branch
     * projection, dropoff from the order's own snapshot, and the earning this
     * trip is expected to pay.
     *
     * Shared with the claim so an agent's offer and the task they end up
     * holding are literally the same shape — an agent comparing the two should
     * never have to reconcile a difference we introduced.
     */
    buildTask = (
        order: OrderEntity,
        branch: BranchLookup,
        itemsCount: number,
        expiresAt?: Date,
    ): DeliveryTaskResponseDTO => {
        const distanceMeters = this.tripDistanceMeters(order, branch);
        const pickup: PickupDTO = {
            branchId: branch.id,
            name: branch.name,
            addressText: branch.addressText,
            lat: branch.lat,
            lng: branch.lng,
        };

        return DeliveryTaskResponseDTO.from(
            order,
            pickup,
            itemsCount,
            estimateEarningMinor(distanceMeters),
            Math.round(distanceMeters),
            expiresAt,
        );
    };

    /** Straight-line branch → dropoff, the basis for the earning. */
    tripDistanceMeters = (order: OrderEntity, branch: BranchLookup): number =>
        haversineMeters(branch.lat, branch.lng, order.deliveryLat, order.deliveryLng);

    /**
     * Forgets an order's offer history, so a re-listed order starts from round
     * one. Called when the order leaves the pool — claimed, cancelled.
     */
    clearAttempts = async (orderPublicId: string): Promise<void> => {
        await this.cache.del(attemptsKey(orderPublicId)).catch(() => {});
        await this.cache.del(offeredKey(orderPublicId)).catch(() => {});
    };

    /**
     * Tells the agents who were offered this order, but did not get it, to
     * drop the offer — all except `winnerId`.
     *
     * Best-effort and non-authoritative. If the list has expired or Redis is
     * down, the losers simply keep a dead offer on screen until they tap it
     * and receive `OrderAlreadyAssigned`, which is the fallback their client
     * has to handle anyway.
     */
    announceTaken = async (orderPublicId: string, winnerId: number): Promise<void> => {
        const raw = await this.cache.get(offeredKey(orderPublicId)).catch(() => null);
        if (!raw) return;

        let offered: number[];
        try {
            offered = JSON.parse(raw) as number[];
        } catch {
            return;
        }

        const losers = offered.filter((agentId) => agentId !== winnerId);
        if (losers.length === 0) return;

        wsPublish(losers.map(wsChannels.agent), DeliveryWsEvent.TAKEN, {orderPublicId});
    };

    private rememberOffer = async (orderPublicId: string, agentIds: number[]): Promise<void> => {
        await this.cache
            .set(offeredKey(orderPublicId), JSON.stringify(agentIds), env.dispatch.offerTtlSec)
            .catch(() => {});
    };

    /**
     * Which round this is, counted in Redis rather than on the order row.
     *
     * Deliberately ephemeral. The count is scaffolding for a decision that
     * only matters while the order is waiting — nobody audits how many times
     * an order was offered, and persisting it would mean a column, a migration
     * and a write on the hot path to hold a number with a half-hour lifespan.
     * If Redis loses it the order gets another few rounds, which is a strictly
     * better failure than giving up early.
     */
    private nextAttempt = async (orderPublicId: string): Promise<number> => {
        const key = attemptsKey(orderPublicId);
        try {
            const attempt = await this.cache.incrementWithTtl(key, ATTEMPTS_TTL_SEC);
            return attempt;
        } catch (err) {
            logger.warn("attempt counter unavailable; treating as first round", {
                orderPublicId,
                error: (err as Error).message,
            });
            return 1;
        }
    };

    /** Round 1 at the base radius, doubling each round, capped. */
    private radiusFor(attempt: number): number {
        const widened =
            env.dispatch.radiusMeters * env.dispatch.radiusEscalation ** Math.max(0, attempt - 1);
        return Math.min(widened, env.dispatch.radiusMaxMeters);
    }

    private publishStalled = (order: OrderEntity, attempt: number): void => {
        logger.warn("dispatch stalled; leaving order ready", {
            orderPublicId: order.publicId,
            region: order.region,
            branchId: order.branchId,
            attempt,
        });
        wsPublish([wsChannels.admin()], DeliveryWsEvent.STALLED, {
            orderPublicId: order.publicId,
            branchId: order.branchId,
            region: order.region,
            attempts: attempt - 1,
        });
    };
}

/**
 * What a trip of this length pays, in minor units.
 *
 * Independent of what the customer paid, on purpose: a long delivery on a
 * cheap order still pays the agent for the distance, and a short delivery on
 * an expensive one does not overpay. Exported because settlement prices the
 * *same* way from the same inputs — the estimate on the offer and the figure
 * stamped into `agent_earnings` must come from one function or they will drift.
 */
export function estimateEarningMinor(distanceMeters: number): number {
    const km = distanceMeters / 1000;
    return Math.round(env.earnings.baseMinor + env.earnings.perKmMinor * km);
}

/** How many orders one sweep pass offers per region. */
const SWEEP_BATCH = 50;

/**
 * Long enough to outlive any order's time in the pool, short enough that the
 * key cannot leak forever if an order never leaves it.
 */
const ATTEMPTS_TTL_SEC = 60 * 60;

function attemptsKey(orderPublicId: string): string {
    return `dispatch:attempts:${orderPublicId}`;
}

function offeredKey(orderPublicId: string): string {
    return `dispatch:offered:${orderPublicId}`;
}

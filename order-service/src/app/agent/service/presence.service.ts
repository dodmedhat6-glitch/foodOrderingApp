import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {logger} from "../../../lib/logger/logger";
import {IPresenceStore, PresenceCandidate} from "../../../pkg/presence/presence.interface";
import {ActiveOrderRef} from "../types";

/**
 * Who is out there, and where.
 *
 * **Redis is the only copy** (docs/database-design.md s3.8). There is no
 * `agent_presence` table, no write-through and nothing to reconcile: presence
 * answers "which agents are near this branch right now", and the answer is
 * worthless once it is five minutes old. Losing the whole thing is a supported
 * state — every agent re-registers on their next ping, at most 30 seconds
 * away, and the durable facts (who holds what, who earned what) live in
 * `orders` and `agent_earnings`.
 *
 * The five-minute rule is **not implemented here**. It is the TTL on the
 * presence store's meta key: an agent who stops pinging simply stops existing.
 * Nothing in this file compares a timestamp to decide whether someone is
 * fresh, which is the point — there is no second place for the rule to drift
 * to.
 *
 * The region is the store's namespace, so an agent in `eg` is invisible to a
 * branch in `sa` without any filtering in application code.
 */
@injectable()
export class PresenceService {
    constructor(@inject(TOKENS.PresenceStore) private readonly store: IPresenceStore) {}

    /**
     * Registers or refreshes an agent at a position, resetting their liveness.
     *
     * `online` and `ping` are the same write — the difference is entirely in
     * what the caller does around it (the controller rejects a ping from an
     * agent with no live entry; going online has no such precondition). Making
     * them one method is what guarantees a ping can never produce a subtly
     * different presence record than an announcement.
     */
    touch = async (region: string, agentId: number, lat: number, lng: number): Promise<void> => {
        await this.store.touch(region, agentId, lat, lng);
    };

    /** Whether this agent currently exists to dispatch. */
    isOnline = async (region: string, agentId: number): Promise<boolean> =>
        (await this.store.read(region, agentId)) !== null;

    /** Removes the agent from dispatch entirely. Idempotent. */
    goOffline = async (region: string, agentId: number): Promise<void> => {
        await this.store.remove(region, agentId);
    };

    /**
     * Records the order an agent is carrying, so the candidate scan can skip
     * them and a position ping knows which customer to fan out to.
     *
     * A **cache of a fact that lives in `orders`**, and deliberately not the
     * guard for anything. Exclusivity is the conditional UPDATE in the order
     * repository, which is the only check that survives a Redis flush; this
     * exists so the hot paths — the scan, and a ping every 30s from every
     * online agent — do not have to query Postgres to answer a question they
     * ask constantly.
     *
     * Never resurrects a stale agent: if liveness has lapsed there is nothing
     * to annotate (`pkg/presence`), and inventing an entry would put someone
     * who is not there back into the pool.
     */
    setActiveOrder = async (
        region: string,
        agentId: number,
        active: ActiveOrderRef | null,
    ): Promise<void> => {
        await this.store
            .setActivity(region, agentId, active === null ? null : JSON.stringify(active))
            .catch((err) => {
                // Swallowed on purpose. The caller has already committed the
                // claim or the settlement; failing it now would roll back
                // nothing and would turn a cache problem into a customer-facing
                // error. The scan degrades (this agent looks idle until their
                // next ping) and the DB check catches it.
                logger.warn("presence activity write failed", {
                    region,
                    agentId,
                    error: (err as Error).message,
                });
            });
    };

    /** The order this agent is carrying, as presence remembers it. */
    getActiveOrder = async (region: string, agentId: number): Promise<ActiveOrderRef | null> => {
        const record = await this.store.read(region, agentId).catch(() => null);
        if (!record?.activity) return null;

        try {
            return JSON.parse(record.activity) as ActiveOrderRef;
        } catch {
            // Written by us, so this is unreachable short of a schema change
            // mid-deploy. Treat it as "no active order": the DB still knows.
            return null;
        }
    };

    /**
     * The nearest live, idle agents to a point — the candidate pool for one
     * offer round.
     *
     * Two Redis round trips regardless of how many come back, and no sorting
     * or distance maths in application code: `GEOSEARCH` does both.
     *
     * Returns an empty list rather than throwing when Redis is unreachable.
     * Dispatch then stops cleanly — the order stays `ready` and the next sweep
     * retries — which is the behaviour the no-durable-copy design asks for: a
     * Redis outage must not fail a restaurant's `ready` transition or lie to a
     * customer about an order's status.
     */
    findCandidates = async (
        region: string,
        lat: number,
        lng: number,
        radiusMeters: number,
        limit: number,
    ): Promise<PresenceCandidate[]> =>
        this.store.findNearest(region, lat, lng, radiusMeters, limit).catch((err) => {
            logger.error("presence candidate scan failed", {
                region,
                error: (err as Error).message,
            });
            return [];
        });

    /**
     * Drops spatial entries whose liveness lapsed. Housekeeping only — the
     * candidate scan already ignores them — so this keeps the geo set from
     * growing to every agent who ever logged in, and nothing more.
     */
    reapStale = async (region: string): Promise<number> =>
        this.store.reapStale(region).catch((err) => {
            logger.warn("presence sweep failed", {region, error: (err as Error).message});
            return 0;
        });
}

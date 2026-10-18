import {Router} from "express";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {authenticate, requireRole} from "../../lib/auth/guard";
import {SystemRole} from "../../lib/auth/roles";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {AgentController} from "./controller/agent.controller";

export const agentRouter = Router();
const agentController = container.resolve<AgentController>(TOKENS.AgentController);

/**
 * Every route here is agent-self: the subject is the JWT, so there is no
 * resource id to authorize against and no permission in core's catalog to
 * check. `requireRole` is the whole of it (CLAUDE.md s8/RBAC — `rbac()` is for
 * questions about a permission, `requireRole` for questions about who the
 * caller is).
 *
 * `requireRegion` runs first on all of them: presence is namespaced by region,
 * and an agent whose region never resolved would be announcing themselves into
 * nowhere.
 */
const agentOnly = [authenticate, requireRegion, requireRole(SystemRole.DELIVERY_AGENT)];

// Presence. Not idempotency-guarded: these are last-writer-wins by nature —
// replaying a ping just reasserts a position, which is exactly what a retry
// should do, and an idempotency record would cost a Redis round trip to
// prevent nothing.
agentRouter.post("/agents/presence/online", ...agentOnly, agentController.goOnline);
agentRouter.post("/agents/presence/ping", ...agentOnly, agentController.ping);
agentRouter.post("/agents/presence/offline", ...agentOnly, agentController.goOffline);

/**
 * GET /api/agents/tasks — polled by every online agent.
 *
 * Deliberately NOT behind `withCache`. The list is short, indexed, and changes
 * on exactly the events the agent is waiting for; a cache would mean an agent
 * who just claimed an order does not see it for several seconds, and the
 * explicit invalidation needed to avoid that would cost more than the read.
 * Contrast the restaurant dashboard, which is cached because it is polled by
 * many users against the same branch.
 */
agentRouter.get("/agents/tasks", ...agentOnly, agentController.listTasks);

// GET /api/agents/earnings — a money read; always live, never cached.
agentRouter.get("/agents/earnings", ...agentOnly, agentController.listEarnings);

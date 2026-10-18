import {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {AppError} from "../../../lib/error/AppError";
import {sendPaginated, sendSuccess} from "../../../lib/http/response";
import {parsePaginationQuery} from "../../../lib/http/pagination/parse-query";
import {validateBody} from "../../../lib/validation/validate";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {NotAuthenticated} from "../../../lib/auth/errors";
import {TOKENS} from "../../../lib/di/tokens";
import {OrderStatus} from "../../order/enums";
import {AgentOrderFilters} from "../../order/types";
import {DeliveryService} from "../../delivery/service/delivery.service";
import {NotOnlineError} from "../../delivery/errors";
import {AckResponseDTO} from "../../delivery/dto/delivery.response.dto";
import {PresenceRequestDTO} from "../dto/agent.request.dto";
import {AgentService} from "../service/agent.service";
import {PresenceService} from "../service/presence.service";
import {EarningsRange} from "../types";

const InvalidStatusFilter = new AppError("Unknown status filter", 400);
const InvalidDateFilter = new AppError("Invalid from/to date", 400);

/** Statuses an agent may filter their own task list by. */
const AGENT_VISIBLE_STATUSES: ReadonlySet<string> = new Set([
    OrderStatus.ASSIGNED,
    OrderStatus.PICKED,
    OrderStatus.DELIVERED,
]);

/**
 * Validate → call service → response DTO → respond (CLAUDE.md s10). The agent
 * is always the JWT subject, never a path or body parameter, so there is no
 * agent id to validate anywhere in this file.
 *
 * Methods are arrow-function properties so they keep `this` when handed to
 * Express as bare references.
 */
@injectable()
export class AgentController {
    constructor(
        @inject(TOKENS.AgentService) private readonly agentService: AgentService,
        @inject(TOKENS.PresenceService) private readonly presenceService: PresenceService,
        @inject(TOKENS.DeliveryService) private readonly deliveryService: DeliveryService,
    ) {}

    /** POST /api/agents/presence/online */
    goOnline = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const dto = await validateBody(PresenceRequestDTO, req.body);
            await this.agentService.recordPosition(
                concreteRegion(req),
                agentIdOf(req),
                dto.lat,
                dto.lng,
            );
            sendSuccess(res, AckResponseDTO.ok());
        } catch (err) {
            next(err);
        }
    };

    /**
     * POST /api/agents/presence/ping
     *
     * Refuses when the agent has no live presence entry — which covers both
     * "never announced" and "announced six minutes ago and went quiet". An
     * agent cannot drift back into dispatch by pinging; they must re-announce,
     * so a client that was asleep sends a deliberate `online` rather than
     * silently reappearing mid-shift.
     */
    ping = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const dto = await validateBody(PresenceRequestDTO, req.body);
            const region = concreteRegion(req);
            const agentId = agentIdOf(req);

            if (!(await this.presenceService.isOnline(region, agentId))) throw NotOnlineError;

            await this.agentService.recordPosition(region, agentId, dto.lat, dto.lng);
            sendSuccess(res, AckResponseDTO.ok());
        } catch (err) {
            next(err);
        }
    };

    /**
     * POST /api/agents/presence/offline
     *
     * Hands back an `assigned` order on the way out, so going offline cannot
     * strand an order nobody is carrying. A `picked` order blocks it (409):
     * the food is already in the bag.
     */
    goOffline = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const region = concreteRegion(req);
            const agentId = agentIdOf(req);

            await this.deliveryService.releaseActiveOnGoingOffline(agentId, region);
            await this.agentService.goOffline(region, agentId);
            sendSuccess(res, AckResponseDTO.ok());
        } catch (err) {
            next(err);
        }
    };

    /** GET /api/agents/tasks?status= */
    listTasks = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const params = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const {data, meta} = await this.deliveryService.listTasks(
                agentIdOf(req),
                params,
                taskFilters(req),
                concreteRegion(req),
            );
            sendPaginated(res, data, meta);
        } catch (err) {
            next(err);
        }
    };

    /** GET /api/agents/earnings?from=&to= */
    listEarnings = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const params = parsePaginationQuery(req.query as Record<string, unknown>, ["earnedAt"]);
            const earnings = await this.agentService.listEarnings(
                agentIdOf(req),
                earningsRange(req),
                params,
                concreteRegion(req),
            );
            sendSuccess(res, earnings);
        } catch (err) {
            next(err);
        }
    };
}

function agentIdOf(req: Request): number {
    if (!req.user) throw NotAuthenticated;
    return req.user.userId;
}

function concreteRegion(req: Request): string {
    if (!req.region || req.region === "all") throw RegionNotResolvedError;
    return req.region;
}

function taskFilters(req: Request): AgentOrderFilters {
    const raw = req.query.status;
    if (raw === undefined) return {};

    const status = String(raw);
    if (!AGENT_VISIBLE_STATUSES.has(status)) throw InvalidStatusFilter;
    return {status: status as OrderStatus};
}

/**
 * Defaults to the current calendar month, which is the question an agent is
 * actually asking when they open the screen. `to` is exclusive.
 */
function earningsRange(req: Request): EarningsRange {
    const now = new Date();
    const from = parseDate(req.query.from) ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const to = parseDate(req.query.to) ?? new Date(now.getTime() + 1000);

    if (from >= to) throw InvalidDateFilter;
    return {from, to};
}

function parseDate(raw: unknown): Date | undefined {
    if (raw === undefined) return undefined;

    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) throw InvalidDateFilter;
    return parsed;
}

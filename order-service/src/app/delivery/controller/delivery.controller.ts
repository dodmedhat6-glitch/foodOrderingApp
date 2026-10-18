import {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {AppError} from "../../../lib/error/AppError";
import {sendSuccess} from "../../../lib/http/response";
import {validateBody} from "../../../lib/validation/validate";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {NotAuthenticated} from "../../../lib/auth/errors";
import {TOKENS} from "../../../lib/di/tokens";
import {isUuid} from "../../../pkg/utils/uuid";
import {AssignDeliveryRequestDTO} from "../dto/delivery.request.dto";
import {AckResponseDTO} from "../dto/delivery.response.dto";
import {DeliveryService} from "../service/delivery.service";

const InvalidPublicId = new AppError("Invalid order id", 400);

/**
 * Validate → call service → response DTO → respond (CLAUDE.md s10).
 *
 * On every agent-facing route the agent is the JWT subject and never a body
 * field, so an agent cannot act on another agent's behalf. The one exception
 * is the admin override, where `agentId` *is* the point of the request.
 */
@injectable()
export class DeliveryController {
    constructor(@inject(TOKENS.DeliveryService) private readonly deliveryService: DeliveryService) {}

    /** POST /api/orders/:orderId/claim */
    claim = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const task = await this.deliveryService.claim(
                publicIdParam(req),
                userIdOf(req),
                concreteRegion(req),
            );
            sendSuccess(res, task);
        } catch (err) {
            next(err);
        }
    };

    /** POST /api/orders/:orderId/unclaim */
    unclaim = async (req: Request, res: Response, next: NextFunction) => {
        try {
            await this.deliveryService.unclaim(
                publicIdParam(req),
                userIdOf(req),
                concreteRegion(req),
            );
            sendSuccess(res, AckResponseDTO.ok());
        } catch (err) {
            next(err);
        }
    };

    /** POST /api/orders/:orderId/assign — admin override. */
    assign = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const dto = await validateBody(AssignDeliveryRequestDTO, req.body);
            const task = await this.deliveryService.assignByAdmin(
                publicIdParam(req),
                dto.agentId,
                concreteRegion(req),
            );
            sendSuccess(res, task);
        } catch (err) {
            next(err);
        }
    };

    // `picked` and `delivered` are NOT endpoints here. They go through the
    // order module's single status endpoint — PATCH /api/orders/:orderId/status
    // — which routes the agent's targets into this module's service
    // (CLAUDE.md s4: one status endpoint per resource).
}

function userIdOf(req: Request): number {
    if (!req.user) throw NotAuthenticated;
    return req.user.userId;
}

function concreteRegion(req: Request): string {
    if (!req.region || req.region === "all") throw RegionNotResolvedError;
    return req.region;
}

function publicIdParam(req: Request): string {
    // Express 5 types a param as string | string[] (a repeated name yields an
    // array); only the single-value form is a valid order id.
    const raw = req.params.orderId;
    const publicId = Array.isArray(raw) ? undefined : raw;
    if (!publicId || !isUuid(publicId)) throw InvalidPublicId;
    return publicId;
}

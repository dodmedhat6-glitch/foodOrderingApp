import {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {AppError} from "../../../lib/error/AppError";
import {TOKENS} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";
import {validateBody} from "../../../lib/validation/validate";
import {NotAuthenticated} from "../../../lib/auth/errors";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {OrderRequester} from "../../order/service/order.service";
import {OrderScope} from "../../order/types";
import {InitPaymentRequestDTO, RefundRequestDTO} from "../dto/payment.request.dto";
import {PaymentService} from "../service/payment.service";

const InvalidPaymentId = new AppError("Invalid payment id", 400);
const InvalidScope = new AppError("Invalid restaurantId or branchId", 400);

/**
 * Validate -> call service -> DTO -> respond (CLAUDE.md s10). Arrow-function
 * properties so the methods keep `this` when handed to Express bare.
 */
@injectable()
export class PaymentController {
    constructor(@inject(TOKENS.PaymentService) private readonly paymentService: PaymentService) {}

    init = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const dto = await validateBody(InitPaymentRequestDTO, req.body);
            const payment = await this.paymentService.init(dto.orderId, requesterOf(req), {
                region: concreteRegion(req),
                correlationId: req.correlationId,
                idempotencyKey: headerValue(req, "idempotency-key"),
            });
            sendSuccess(res, payment);
        } catch (err) {
            next(err);
        }
    };

    /**
     * `GET /api/restaurants/:restaurantId/branches/:branchId/payments/:paymentId`
     * for restaurant staff, and the unscoped `GET /api/payments/:paymentId`
     * for a customer reading their own. The scope, when the path carries one,
     * narrows the order lookup behind the tenancy check to that branch.
     */
    getById = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const payment = await this.paymentService.getById(
                paymentIdParam(req),
                requesterOf(req),
                concreteRegion(req),
                scopeParams(req),
            );
            sendSuccess(res, payment);
        } catch (err) {
            next(err);
        }
    };

    /**
     * 202, not 200 — the refund has been accepted, not completed. Which
     * status code this is is part of the contract (docs/api-contracts.md
     * s2.4), so it is stated here rather than defaulted.
     */
    refund = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const dto = await validateBody(RefundRequestDTO, req.body);
            const refund = await this.paymentService.refund(
                paymentIdParam(req),
                dto,
                concreteRegion(req),
                {
                    region: concreteRegion(req),
                    correlationId: req.correlationId,
                    idempotencyKey: headerValue(req, "idempotency-key"),
                },
            );
            sendSuccess(res, refund, 202);
        } catch (err) {
            next(err);
        }
    };
}

function requesterOf(req: Request): OrderRequester {
    if (!req.user) throw NotAuthenticated;
    return req.user;
}

/** Every payment lives on exactly one shard; "all" is not an answer here. */
function concreteRegion(req: Request): string {
    if (!req.region || req.region === "all") throw RegionNotResolvedError;
    return req.region;
}

function paymentIdParam(req: Request): number {
    // Express 5 types a repeated param as an array; only the single-value
    // form is a valid id.
    const raw = req.params.paymentId;
    const paymentId = Number(Array.isArray(raw) ? undefined : raw);
    if (!Number.isInteger(paymentId) || paymentId <= 0) throw InvalidPaymentId;
    return paymentId;
}

/**
 * The restaurant/branch pair from the path, or `undefined` on the unscoped
 * route. Malformed is kept distinct from absent for the same reason as in the
 * order controller: collapsing them would quietly widen a scoped read.
 */
function scopeParams(req: Request): OrderScope | undefined {
    if (req.params.restaurantId === undefined && req.params.branchId === undefined) {
        return undefined;
    }

    const restaurantId = positiveIntParam(req.params.restaurantId);
    const branchId = positiveIntParam(req.params.branchId);
    if (restaurantId === undefined || branchId === undefined) throw InvalidScope;

    return {restaurantId, branchId};
}

function positiveIntParam(raw: string | string[] | undefined): number | undefined {
    if (typeof raw !== "string") return undefined;

    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : undefined;
}

function headerValue(req: Request, name: string): string | undefined {
    const raw = req.headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
}

import {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {AppError} from "../../../lib/error/AppError";
import {sendPaginated, sendSuccess} from "../../../lib/http/response";
import {parsePaginationQuery} from "../../../lib/http/pagination/parse-query";
import {validateBody} from "../../../lib/validation/validate";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {NotAuthenticated} from "../../../lib/auth/errors";
import {isUuid} from "../../../pkg/utils/uuid";
import {CreateOrderRequestDTO, UpdateOrderStatusRequestDTO} from "../dto/order.request.dto";
import {OrderStatus} from "../enums";
import {ListOrdersFilters} from "../types";
import {TOKENS} from "../../../lib/di/tokens";
import {OrderRequester, OrderService} from "../service/order.service";

const InvalidPublicId = new AppError("Invalid order id", 400);
const InvalidBranchId = new AppError("branchId query param is required", 400);
const InvalidStatusFilter = new AppError("Unknown status filter", 400);
const InvalidYear = new AppError("Invalid year", 400);
const InvalidDateFilter = new AppError("Invalid from/to date", 400);

// Orders before this didn't exist; anything outside the range is a typo.
const MIN_YEAR = 2020;

/**
 * Validate -> call service -> response DTO -> respond. No business rules here
 * (CLAUDE.md s10): the controller's whole job is turning an HTTP request into
 * typed service arguments, which includes the path and query params that
 * `validateBody` doesn't cover.
 *
 * Methods are arrow-function properties so they keep `this` when handed to
 * Express as bare references.
 */
@injectable()
export class OrderController {
    constructor(@inject(TOKENS.OrderService) private readonly orderService: OrderService) {}

    create = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const dto = await validateBody(CreateOrderRequestDTO, req.body);
            const order = await this.orderService.placeOrder(dto, requesterOf(req), {
                region: concreteRegion(req),
                correlationId: req.correlationId,
                idempotencyKey: headerValue(req, "idempotency-key"),
            });
            sendSuccess(res, order, 201);
        } catch (err) {
            next(err);
        }
    };

    getByPublicId = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const order = await this.orderService.getOrder(
                publicIdParam(req),
                concreteRegion(req),
                requesterOf(req),
            );
            sendSuccess(res, order);
        } catch (err) {
            next(err);
        }
    };

    listForCustomer = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const params = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const {data, meta} = await this.orderService.listCustomerOrders(
                requesterOf(req),
                concreteRegion(req),
                params,
                yearParam(req),
            );
            sendPaginated(res, data, meta);
        } catch (err) {
            next(err);
        }
    };

    listForRestaurant = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const params = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const {data, meta} = await this.orderService.listRestaurantOrders(
                branchIdParam(req),
                params,
                listFilters(req),
                concreteRegion(req),
            );
            sendPaginated(res, data, meta);
        } catch (err) {
            next(err);
        }
    };

    updateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const dto = await validateBody(UpdateOrderStatusRequestDTO, req.body);
            const result = await this.orderService.updateStatus(
                publicIdParam(req),
                dto.status,
                dto.reason,
                requesterOf(req),
                concreteRegion(req),
            );
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    };
}

function requesterOf(req: Request): OrderRequester {
    if (!req.user) throw NotAuthenticated;
    return req.user;
}

/**
 * Writes and single-shard reads need one concrete region: "all" is only
 * meaningful for admin fan-out reads, which this module doesn't serve.
 */
function concreteRegion(req: Request): string {
    if (!req.region || req.region === "all") throw RegionNotResolvedError;
    return req.region;
}

function publicIdParam(req: Request): string {
    // Express 5 types a param as string | string[] (a repeated name yields an
    // array); only the single-value form is a valid order id.
    const raw = req.params.orderId ?? req.params.publicId;
    const publicId = Array.isArray(raw) ? undefined : raw;
    if (!publicId || !isUuid(publicId)) throw InvalidPublicId;
    return publicId;
}

function branchIdParam(req: Request): number {
    const branchId = Number(req.query.branchId);
    if (!Number.isInteger(branchId) || branchId <= 0) throw InvalidBranchId;
    return branchId;
}

function yearParam(req: Request): number {
    if (req.query.year === undefined) return new Date().getFullYear();

    const year = Number(req.query.year);
    if (!Number.isInteger(year) || year < MIN_YEAR || year > new Date().getFullYear() + 1) {
        throw InvalidYear;
    }
    return year;
}

function listFilters(req: Request): ListOrdersFilters {
    const filters: ListOrdersFilters = {};

    if (typeof req.query.status === "string") {
        const status = req.query.status as OrderStatus;
        if (!Object.values(OrderStatus).includes(status)) throw InvalidStatusFilter;
        filters.status = status;
    }

    filters.from = dateQuery(req, "from");
    filters.to = dateQuery(req, "to");
    return filters;
}

function dateQuery(req: Request, name: string): Date | undefined {
    const raw = req.query[name];
    if (typeof raw !== "string" || raw.length === 0) return undefined;

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw InvalidDateFilter;
    return parsed;
}

function headerValue(req: Request, name: string): string | undefined {
    const raw = req.headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
}

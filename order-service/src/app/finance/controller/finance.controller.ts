import {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {AppError} from "../../../lib/error/AppError";
import {TOKENS} from "../../../lib/di/tokens";
import {sendPaginated, sendSuccess} from "../../../lib/http/response";
import {parsePaginationQuery} from "../../../lib/http/pagination/parse-query";
import {validateBody} from "../../../lib/validation/validate";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {CreatePayoutRequestDTO} from "../dto/finance.request.dto";
import {FinanceService} from "../service/finance.service";
import {FinanceRange} from "../types";

const InvalidRestaurantId = new AppError("Invalid restaurantId", 400);
const InvalidDateFilter = new AppError("Invalid from/to date", 400);
const IdempotencyKeyMissing = new AppError("Missing Idempotency-Key header", 400);

/** restaurant-finance.md s3: the payout list looks back 90 days unless told otherwise. */
const DEFAULT_PAYOUT_LOOKBACK_DAYS = 90;

/**
 * Validate → call service → response DTO → respond (CLAUDE.md s10). The
 * restaurant is always the path's `:restaurantId` — the tenancy guard has
 * already checked the caller belongs to it — so nothing here reads it from
 * the body or the JWT.
 */
@injectable()
export class FinanceController {
    constructor(@inject(TOKENS.FinanceService) private readonly financeService: FinanceService) {}

    /** GET /api/restaurants/:restaurantId/finance/balance */
    getBalance = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const balance = await this.financeService.getBalance(
                restaurantIdParam(req),
                concreteRegion(req),
            );
            sendSuccess(res, balance);
        } catch (err) {
            next(err);
        }
    };

    /** GET /api/restaurants/:restaurantId/finance/payouts?from=&to= */
    listPayouts = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const params = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const {data, meta} = await this.financeService.listPayouts(
                restaurantIdParam(req),
                rangeOf(req, daysAgo(DEFAULT_PAYOUT_LOOKBACK_DAYS)),
                params,
                concreteRegion(req),
            );
            sendPaginated(res, data, meta);
        } catch (err) {
            next(err);
        }
    };

    /** GET /api/restaurants/:restaurantId/finance/summary?from=&to= — defaults to this month. */
    getSummary = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const summary = await this.financeService.getSummary(
                restaurantIdParam(req),
                rangeOf(req, startOfMonth()),
                concreteRegion(req),
            );
            sendSuccess(res, summary);
        } catch (err) {
            next(err);
        }
    };

    /** POST /api/restaurants/:restaurantId/finance/payouts (admin) */
    recordPayout = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const dto = await validateBody(CreatePayoutRequestDTO, req.body);
            const payout = await this.financeService.recordPayout(restaurantIdParam(req), dto, {
                region: concreteRegion(req),
                idempotencyKey: idempotencyKeyOf(req),
                correlationId: req.correlationId,
            });
            sendSuccess(res, payout, 201);
        } catch (err) {
            next(err);
        }
    };
}

/** Every balance lives on exactly one shard; "all" is not an answer here. */
function concreteRegion(req: Request): string {
    if (!req.region || req.region === "all") throw RegionNotResolvedError;
    return req.region;
}

function restaurantIdParam(req: Request): number {
    // Express 5 types a repeated param as an array; only the single-value
    // form is a valid id.
    const raw = req.params.restaurantId;
    const id = Number(Array.isArray(raw) ? undefined : raw);
    if (!Number.isInteger(id) || id <= 0) throw InvalidRestaurantId;
    return id;
}

/** `[from, to)`; `to` defaults to just past now so a row written this instant is included. */
function rangeOf(req: Request, defaultFrom: Date): FinanceRange {
    const from = parseDate(req.query.from) ?? defaultFrom;
    const to = parseDate(req.query.to) ?? new Date(Date.now() + 1000);

    if (from >= to) throw InvalidDateFilter;
    return {from, to};
}

function parseDate(raw: unknown): Date | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") throw InvalidDateFilter;

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw InvalidDateFilter;
    return parsed;
}

function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function startOfMonth(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The route runs strict idempotency, so the header is always there by now.
 * Re-checked anyway because the ledger's own idempotency key is built from it.
 */
function idempotencyKeyOf(req: Request): string {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key) throw IdempotencyKeyMissing;
    return key;
}

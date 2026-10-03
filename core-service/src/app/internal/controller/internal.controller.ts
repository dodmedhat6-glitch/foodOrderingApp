import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { tokens } from "../../../lib/di/tokens";
import { sendSuccess } from "../../../lib/http/response";
import { AppError } from "../../../lib/error/AppError";
import { InternalService } from "../service/internal.service";
import { ReserveStockLine } from "../../product/repository/product-branch-details.repository";

@injectable()
export class InternalController {
    constructor(@inject(tokens.InternalService) private readonly internalService: InternalService) {
    }

    getBranch = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.internalService.getBranch(Number(req.params.branchId));
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    }

    getAddress = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.internalService.getAddress(Number(req.params.addressId));
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    }

    getUser = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.internalService.getUser(Number(req.params.userId));
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    }

    getProducts = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const branchId = Number(req.query.branchId);
            const idsParam = req.query.ids;
            if (!Number.isFinite(branchId) || branchId <= 0 || typeof idsParam !== "string" || idsParam.length === 0) {
                throw new AppError("branchId and ids (comma-separated) query params are required", 400);
            }

            const productIds = idsParam.split(",").map((id) => Number(id.trim())).filter((id) => Number.isFinite(id));
            const result = await this.internalService.getProducts(productIds, branchId);
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    }

    /**
     * POST /api/internal/branches/:branchId/reserve-stock
     *
     * Body is validated inline rather than through a request DTO because the
     * only caller is order-service, which has already validated the basket
     * against its own CreateOrderRequestDTO; this is a guard against a
     * malformed internal call, not a user-facing validation surface.
     */
    reserveStock = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const branchId = Number(req.params.branchId);
            if (!Number.isFinite(branchId) || branchId <= 0) {
                throw new AppError("branchId path param must be a positive integer", 400);
            }

            const lines = parseReserveStockLines(req.body?.items);
            const result = await this.internalService.reserveStock(branchId, lines);
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    }
}

function parseReserveStockLines(raw: unknown): ReserveStockLine[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new AppError("items must be a non-empty array", 400);
    }

    return raw.map((item) => {
        const productId = Number((item as any)?.productId);
        const quantity = Number((item as any)?.quantity);
        if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
            throw new AppError("each item needs a positive integer productId and quantity", 400);
        }
        return { productId, quantity };
    });
}

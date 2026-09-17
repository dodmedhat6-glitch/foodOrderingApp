import {Request, Response, NextFunction} from "express";
import {validateBody} from "../../../lib/validation/validate";
import {SystemRole} from "../../user/enums";
import {CreateBranchDTO, UpdateBranchDTO, UpdateBranchStatusDTO} from "../dto/branch.dto";
import {BranchService} from "../service/branch.service";
import {inject, injectable} from "tsyringe";
import {tokens} from "../../../lib/di/tokens";

function normalizeTime(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && value.includes("T")) {
        return date.toISOString().slice(11, 19);
    }

    return value;
}

function normalizeBranchBody(body: unknown): unknown {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return body;
    }

    const data = body as Record<string, unknown>;
    const normalized = {...data};

    if (normalized.closesAt === undefined && normalized.closeAt !== undefined) {
        normalized.closesAt = normalized.closeAt;
    }

    normalized.opensAt = normalizeTime(normalized.opensAt);
    normalized.closesAt = normalizeTime(normalized.closesAt);

    return normalized;
}

@injectable()
export class BranchController {
    constructor(@inject(tokens.BranchService) private readonly branchService: BranchService) {
    }

    create = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(CreateBranchDTO, normalizeBranchBody(req.body));
            const branch = await this.branchService.create(Number(req.params.restaurantId), req.user?.user_id!, req.user?.role! as SystemRole, data);
            res.status(201).json({message: "Branch created", branch});
        } catch (err) {
            next(err);
        }
    }

    findNearby = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const results = await this.branchService.findNearby( Number(req.query.lat), Number(req.query.lng))
            res.status(200).json({data :results});
            console.log(results)
        } catch (err) {
            next(err);
        }
    }

    findByRestaurant = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const results = await this.branchService.findByRestaurant(Number(req.params.restaurantId));
            res.status(200).json({data: results});
        } catch (err) {
            next(err);
        }
    }

    update = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(UpdateBranchDTO, normalizeBranchBody(req.body));
            const branch = await this.branchService.update(Number(req.params.branchId), req.user?.user_id!, req.user?.role! as SystemRole, data);
            res.status(200).json({message: "Branch updated", branch});
        } catch (err) {
            next(err);
        }
    }

    updateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(UpdateBranchStatusDTO, req.body);
            const branch = await this.branchService.updateStatus(Number(req.params.branchId), req.user?.role! as SystemRole, data);
            res.status(200).json({message: "Branch status updated", branch: {id: branch.id, isActive: branch.isActive, acceptOrders: branch.acceptOrders, commission: branch.commission}});
        } catch (err) {
            next(err);
        }
    }
}

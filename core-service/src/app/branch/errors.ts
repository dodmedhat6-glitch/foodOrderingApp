import {AppError} from "../../common/error/AppError";

export const BranchNotFoundError = new AppError('Branch not found', 404);

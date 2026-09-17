import {AppError} from "../../lib/error/AppError";

export const CannotCreateOwnerUserError = new AppError("can't create owner user", 400);
export const RoleNotFound = new AppError("Role Not Found", 404);
export const MemberNotFound = new AppError("member not found" , 404)
export const RoleNotFoundError  = new AppError("role not found" , 404)
export const CannotDeleteOwnerUser = new AppError("can't delete owner ", 400);
export const InvalidBranchIdsError = new AppError("invalid branch ids" , 403)

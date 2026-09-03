import {AppError} from "../../common/error/AppError";

export const CannotCreateOwnerUserError = new AppError("can't create owner user", 400);
export const RoleNotFound = new AppError("Role Not Found", 404);

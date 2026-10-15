import {AppError} from "../error/AppError";

export const NotAuthenticated = new AppError("User not authenticated", 401);
export const UnAuthorisedError = new AppError("User not authorised", 403);
export const PermissionDenied = new AppError("Permission denied", 403);

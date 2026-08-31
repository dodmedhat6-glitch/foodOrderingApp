import {AppError} from "../../common/error/AppError";

export const RestaurantNotFoundError = new AppError('Restaurant not found', 404);

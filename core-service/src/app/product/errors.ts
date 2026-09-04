import {AppError} from "../../common/error/AppError";

export const ProductNotFoundError = new AppError('Product not found', 404);

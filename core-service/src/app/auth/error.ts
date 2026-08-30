import { AppError } from '../../common/error/AppError'

export const UserAlreadyExistsError = new AppError('User Already exists with same phone or email', 400);
export const CannotSignupAsAdmin = new AppError('unauthorized', 403)
export const IncorrectCredentials = new AppError("Incorrect email or password", 401);
export const InvalidOTP = new AppError("Invalid OTP", 401);
export const RestaurantDataRequiredError = new AppError("Restaurant data is required", 400);




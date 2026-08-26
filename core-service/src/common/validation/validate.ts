import { validate } from "class-validator";
import { AppError } from "../error/AppError"

export async function validateBody<T extends object>(cls: new (...args: any[]) => T, body: unknown): Promise<T> {
    if (typeof cls !== "function") {
        throw new AppError("Invalid validation schema", 500);
    }

    const instance = Object.assign(Object.create(cls.prototype), body);
    const error = await validate(instance, { whitelist: true });

    if (error.length > 0) {
        const message = error.flatMap((e) => Object.values(e.constraints ?? {}));
        throw new AppError(message.join('\n'), 400)
    }

    return instance;
}
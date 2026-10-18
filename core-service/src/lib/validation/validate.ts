import { validate, ValidationError } from "class-validator";
import { AppError } from "../error/AppError"
import {plainToInstance} from "class-transformer";

export async function validateBody<T extends object>(cls: new (...args: any[]) => T, body: unknown): Promise<T> {
    if (typeof cls !== "function") {
        throw new AppError("Invalid validation schema", 500);
    }

    const instance = plainToInstance(cls, body);
    const error = await validate(instance, { whitelist: true });

    if (error.length > 0) {
        throw new AppError(flattenMessages(error).join('\n'), 400)
    }

    return instance;
}

/**
 * Every constraint message, descending into nested errors. A failure inside a
 * nested DTO (e.g. `restaurant.primaryCountry` on registration) carries no
 * `constraints` of its own - the messages hang off `children` - so reading only
 * the top level produced a 400 with an empty message. Paths are prefixed so the
 * caller can tell which field failed.
 */
function flattenMessages(errors: ValidationError[], path = ""): string[] {
    return errors.flatMap((e) => {
        const here = path ? `${path}.${e.property}` : e.property;
        const own = path
            ? Object.values(e.constraints ?? {}).map((m) => `${here}: ${m}`)
            : Object.values(e.constraints ?? {});
        const nested = e.children?.length ? flattenMessages(e.children, here) : [];
        return [...own, ...nested];
    });
}

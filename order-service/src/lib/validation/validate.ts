import {plainToInstance} from "class-transformer";
import {validate, ValidationError} from "class-validator";
import {AppError} from "../error/AppError";

export async function validateBody<T extends object>(
    cls: new () => T,
    body: unknown,
): Promise<T> {
    const instance = plainToInstance(cls, body);
    const errors = await validate(instance, {whitelist: true});

    if (errors.length > 0) {
        throw new AppError(flattenMessages(errors).join("; "), 400);
    }
    return instance;
}

/**
 * Collects every constraint message, descending into nested errors.
 *
 * A `@ValidateNested` failure carries no `constraints` of its own — the real
 * messages hang off `children`, one level per array index for `{each: true}`.
 * Reading only the top level yields an empty string, which is how a bad
 * `items[0].quantity` surfaced as `{"error": ""}` with a 400 and nothing for
 * the client to act on.
 *
 * Paths are prefixed (`items.0.quantity: ...`) so the caller can tell which
 * line of a 100-item basket was rejected.
 */
function flattenMessages(errors: ValidationError[], path = ""): string[] {
    return errors.flatMap((error) => {
        const here = path ? `${path}.${error.property}` : error.property;
        const own = Object.values(error.constraints ?? {}).map((message) => `${here}: ${message}`);
        const nested = error.children?.length ? flattenMessages(error.children, here) : [];
        return [...own, ...nested];
    });
}

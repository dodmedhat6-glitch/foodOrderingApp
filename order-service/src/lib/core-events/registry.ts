import {CoreEventHandler} from "./types";

/**
 * The event-type → handler map, split out of the consumer so that registering
 * a handler costs nothing from the broker and the handlers can be driven
 * without one (play/test-core-events.ts exercises the registered function
 * itself, not a copy of the dispatch logic).
 *
 * Registration is strict: two handlers for one event type is a wiring mistake,
 * and the second would silently win. It throws at boot rather than at the
 * first message.
 */
const handlers = new Map<string, CoreEventHandler>();

export function registerHandler(eventType: string, handler: CoreEventHandler): void {
    if (handlers.has(eventType)) {
        throw new Error(`Handler already registered for ${eventType}`);
    }
    handlers.set(eventType, handler);
}

export function getHandler(eventType: string): CoreEventHandler | undefined {
    return handlers.get(eventType);
}

export function listRegisteredHandlers(): string[] {
    return Array.from(handlers.keys());
}

/**
 * Drops every registration. Only for tests and the play scripts, which call
 * `registerCoreEventHandlers` more than once in a process; the strict
 * registration above would otherwise throw on the second call.
 */
export function resetHandlers(): void {
    handlers.clear();
}

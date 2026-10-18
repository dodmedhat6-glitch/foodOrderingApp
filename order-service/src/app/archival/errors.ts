/**
 * The hot-side delete removed a row the archive copy did not include — a row
 * written to a finished order between the copy and the delete. Internal
 * control flow, never surfaced over HTTP: the batch rolls back and is retried
 * with the new row in it, so it is an `Error` subclass rather than an
 * `AppError` instance.
 */
export class StragglerRowError extends Error {}

/**
 * Semantic error taxonomy — the PURE layer.
 *
 * Nothing here knows what HTTP is. "Not found" and "conflict" are application
 * concepts that mean the same in a worker or a cron, where a status code would
 * be meaningless. The translation to HTTP lives in exactly one place:
 * `src/infra/http/errors/error-handler.ts`.
 *
 * `code` is public contract: the mobile client branches on it and uses it as an
 * i18n key. `message` is not contract — it is for logs, debugging and clients
 * without translations, and must never be shown raw in a localized UI.
 */
export abstract class AppError extends Error {
  abstract readonly code: string

  /**
   * True when the error is itself a signal worth investigating — refresh
   * token reuse, not a plain expiry — rather than routine client failure. The
   * error handler logs these at `warn`; every other `AppError` answers the
   * client with no log line, because its own `code` already told the story
   * (decision 15).
   */
  readonly securityEvent: boolean = false
}

export abstract class NotFoundError extends AppError {}
export abstract class ConflictError extends AppError {}
export abstract class UnauthorizedError extends AppError {}
export abstract class ForbiddenError extends AppError {}
export abstract class ValidationError extends AppError {}
export abstract class BusinessRuleError extends AppError {}

/**
 * A failure that repeating may resolve on its own: nothing about the request is
 * wrong, and the same operation attempted again will probably succeed. A
 * database deadlock is the canonical case — Postgres kills one of two
 * transactions precisely so the other can proceed.
 *
 * It is a category rather than a 500 because the distinction is the client's to
 * act on: "come back in a moment" and "this request has a defect" call for
 * opposite behaviour, and only the first is worth retrying.
 */
export abstract class TransientError extends AppError {}

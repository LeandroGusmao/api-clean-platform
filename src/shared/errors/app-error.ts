/**
 * Semantic error taxonomy — the PURE layer.
 *
 * Nothing here knows what HTTP is. "Not found" and "conflict" are application
 * concepts that mean the same in a worker or a cron, where a status code would
 * be meaningless. The translation to HTTP lives in exactly one place:
 * `src/infra/http/error-handler.ts`.
 *
 * `code` is public contract: the mobile client branches on it and uses it as an
 * i18n key. `message` is not contract — it is for logs, debugging and clients
 * without translations, and must never be shown raw in a localized UI.
 */
export abstract class AppError extends Error {
  abstract readonly code: string
}

export abstract class NotFoundError extends AppError {}
export abstract class ConflictError extends AppError {}
export abstract class UnauthorizedError extends AppError {}
export abstract class ForbiddenError extends AppError {}
export abstract class ValidationError extends AppError {}
export abstract class BusinessRuleError extends AppError {}

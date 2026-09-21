import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { getTraceId } from '#infra/observability/request-context'
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TransientError,
  UnauthorizedError,
  ValidationError,
} from '#shared/errors/app-error'
import {
  BAD_REQUEST_CODE,
  type ErrorResponse,
  INTERNAL_SERVER_ERROR_CODE,
  INTERNAL_SERVER_ERROR_MESSAGE,
  ROUTE_NOT_FOUND_CODE,
  ROUTE_NOT_FOUND_MESSAGE,
  TOO_MANY_REQUESTS_CODE,
  VALIDATION_ERROR_CODE,
  VALIDATION_ERROR_MESSAGE,
} from './error-response.js'
import { toValidationDetails, type ValidationDetail } from './validation-issues.js'

const BAD_REQUEST_STATUS = 400
const UNAUTHORIZED_STATUS = 401
const FORBIDDEN_STATUS = 403
const NOT_FOUND_STATUS = 404
const CONFLICT_STATUS = 409
const UNPROCESSABLE_ENTITY_STATUS = 422
const TOO_MANY_REQUESTS_STATUS = 429
const SERVICE_UNAVAILABLE_STATUS = 503
const INTERNAL_SERVER_ERROR_STATUS = 500

const CLIENT_ERROR_MIN_STATUS = 400
const CLIENT_ERROR_MAX_STATUS = 499

const UNHANDLED_ERROR_LOG_MESSAGE = 'unhandled error'
const SECURITY_EVENT_LOG_MESSAGE = 'security event'

const RETRY_AFTER_HEADER = 'retry-after'
/**
 * Seconds. Deliberately a constant: a value derived from real load would have
 * to measure the load, and nothing consumes that yet. One second is long enough
 * for a lock holder to finish and short enough that a client honouring it feels
 * responsive.
 */
const RETRY_AFTER_SECONDS = 1

/**
 * The only HTTP mapping in the system. It does not grow with the number of
 * domain errors — a hundred of them still land in these seven categories.
 *
 * The seven are siblings: each extends `AppError` directly. If one ever
 * extended another, this table would silently start depending on row order.
 */
const STATUS_BY_CATEGORY: ReadonlyArray<
  [abstract new (...args: never[]) => AppError, number]
> = [
  [NotFoundError, NOT_FOUND_STATUS],
  [ConflictError, CONFLICT_STATUS],
  [UnauthorizedError, UNAUTHORIZED_STATUS],
  [ForbiddenError, FORBIDDEN_STATUS],
  [ValidationError, BAD_REQUEST_STATUS],
  [BusinessRuleError, UNPROCESSABLE_ENTITY_STATUS],
  [TransientError, SERVICE_UNAVAILABLE_STATUS],
]

function statusForCategory(error: AppError): number | undefined {
  for (const [category, status] of STATUS_BY_CATEGORY) {
    if (error instanceof category) return status
  }
  return undefined
}

function isClientError(
  error: FastifyError,
): error is FastifyError & { statusCode: number } {
  return (
    typeof error.statusCode === 'number' &&
    error.statusCode >= CLIENT_ERROR_MIN_STATUS &&
    error.statusCode <= CLIENT_ERROR_MAX_STATUS
  )
}

function buildErrorResponse(
  code: string,
  message: string,
  traceId: string,
): ErrorResponse {
  return { error: { code, message, traceId } }
}

function buildValidationResponse(
  details: ValidationDetail[],
  traceId: string,
): ErrorResponse {
  return {
    error: {
      code: VALIDATION_ERROR_CODE,
      message: VALIDATION_ERROR_MESSAGE,
      details,
      traceId,
    },
  }
}

/**
 * `getTraceId()` is always set inside a request — the `onRequest` hook in
 * `server.ts` opens the context before any handler runs, and that was verified
 * for both handlers. The fallback exists only to satisfy the type.
 */
function traceIdFor(request: FastifyRequest): string {
  return getTraceId() ?? request.id
}

function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const traceId = traceIdFor(request)

  // Must come first: FST_ERR_VALIDATION carries a 4xx statusCode, so a later
  // branch would swallow it. The library's guard is used instead of comparing
  // `error.code`, because it also confirms the issues came from Zod and are
  // therefore translatable.
  if (hasZodFastifySchemaValidationErrors(error)) {
    return reply
      .status(BAD_REQUEST_STATUS)
      .send(buildValidationResponse(toValidationDetails(error.validation), traceId))
  }

  if (error instanceof AppError) {
    const status = statusForCategory(error)

    if (status !== undefined) {
      // The one category that says anything beyond the status: a 503 without
      // `Retry-After` tells the client it may try again but not when, which
      // invites a tight loop against a database already under contention. No
      // other category gets one — repeating a 409 will not resolve it.
      if (error instanceof TransientError) {
        reply.header(RETRY_AFTER_HEADER, String(RETRY_AFTER_SECONDS))
      }

      // The taxonomy answers most errors with no log line at all: the `code`
      // in the response carries that story. This is the
      // one exception: a security event still reaches the client as an
      // ordinary status, and without a log line here it is indistinguishable
      // from routine traffic — refresh token reuse and a plain expired token
      // would both be a silent 401.
      if (error.securityEvent) {
        request.log.warn({ code: error.code, traceId }, SECURITY_EVENT_LOG_MESSAGE)
      }

      return reply
        .status(status)
        .send(buildErrorResponse(error.code, error.message, traceId))
    }
    // An AppError outside the taxonomy is a programming mistake, not a client
    // problem: it falls through to the generic branch rather than guessing.
  }

  // Must precede the generic 4xx branch, which would flatten this into
  // BAD_REQUEST — and "your request has a defect" is the opposite instruction
  // from "you sent too much, come back later". Keyed on the status rather than
  // on the rate limiter's error, so the library's name never becomes public
  // contract: the same reasoning that keeps FST_ERR_* out of the envelope.
  //
  // No `Retry-After` is set here. The limiter already put one on the reply
  // before throwing, carrying the seconds that actually remain in the window,
  // and it survives — a second one would overwrite a measurement with a guess.
  if (isClientError(error) && error.statusCode === TOO_MANY_REQUESTS_STATUS) {
    return reply
      .status(TOO_MANY_REQUESTS_STATUS)
      .send(buildErrorResponse(TOO_MANY_REQUESTS_CODE, error.message, traceId))
  }

  if (isClientError(error)) {
    // 4xx means the client is at fault, and Fastify's message for these talks
    // about the request rather than about internals. One code, not a table
    // keyed by FST_ERR_*: the framework name must not become public contract,
    // and the HTTP status already tells 413 from 415.
    return reply
      .status(error.statusCode)
      .send(buildErrorResponse(BAD_REQUEST_CODE, error.message, traceId))
  }

  request.log.error({ err: error }, UNHANDLED_ERROR_LOG_MESSAGE)

  return reply
    .status(INTERNAL_SERVER_ERROR_STATUS)
    .send(
      buildErrorResponse(
        INTERNAL_SERVER_ERROR_CODE,
        INTERNAL_SERVER_ERROR_MESSAGE,
        traceId,
      ),
    )
}

function handleNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .status(NOT_FOUND_STATUS)
    .send(
      buildErrorResponse(
        ROUTE_NOT_FOUND_CODE,
        ROUTE_NOT_FOUND_MESSAGE,
        traceIdFor(request),
      ),
    )
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(handleError)
  // Without this, the most common 404 of all — a typo in the path — answers in
  // Fastify's own shape and puts a hole in the envelope contract.
  app.setNotFoundHandler(handleNotFound)
}

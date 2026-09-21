import { TransientError } from '#shared/errors/app-error'

const RATE_LIMIT_STORE_UNAVAILABLE_ERROR_NAME = 'RateLimitStoreUnavailableError'
const RATE_LIMIT_STORE_UNAVAILABLE_CODE = 'RATE_LIMIT_STORE_UNAVAILABLE'
const RATE_LIMIT_STORE_UNAVAILABLE_MESSAGE =
  'The rate limit store is unreachable; retry shortly'

/**
 * The counter behind a route's own ceiling could not be reached, and the route
 * refuses instead of answering uncounted.
 *
 * `securityEvent: true` is what makes the error handler log it: a transient
 * error is otherwise a 503 with no line at all, and a control that stopped
 * controlling would look like ordinary traffic.
 *
 * Carries **no `cause`**, for the same reason `TransactionConflictError` carries
 * none: pino's serializer concatenates the cause chain into the parent's
 * message, and the driver error underneath holds the server address.
 */
export class RateLimitStoreUnavailableError extends TransientError {
  readonly code = RATE_LIMIT_STORE_UNAVAILABLE_CODE
  override readonly securityEvent = true

  constructor() {
    super(RATE_LIMIT_STORE_UNAVAILABLE_MESSAGE)
    this.name = RATE_LIMIT_STORE_UNAVAILABLE_ERROR_NAME
  }
}

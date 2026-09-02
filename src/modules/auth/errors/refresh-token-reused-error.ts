import { UnauthorizedError } from '#shared/errors/app-error'

const REFRESH_TOKEN_REUSED_CODE = 'REFRESH_TOKEN_REUSED'
const REFRESH_TOKEN_REUSED_MESSAGE =
  'Refresh token was already used; the session family has been revoked'

/**
 * A refresh token presented after it was already spent, outside the grace
 * window. The family is revoked before this is thrown.
 *
 * A separate code from `InvalidRefreshTokenError`, and the reason is
 * observability: decision 15 keeps the use case from logging and makes the
 * error `code` the log line instead. Folding the two together would erase from
 * the logs the only trace that reuse detection ever fired — the security event
 * this whole design exists to produce. The client also acts differently: this
 * one means "wipe the secure storage and send the user back to the login
 * screen", not "retry".
 */
export class RefreshTokenReusedError extends UnauthorizedError {
  readonly code = REFRESH_TOKEN_REUSED_CODE

  constructor() {
    super(REFRESH_TOKEN_REUSED_MESSAGE)
  }
}

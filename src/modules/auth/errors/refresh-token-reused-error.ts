import { UnauthorizedError } from '#shared/errors/app-error'

const REFRESH_TOKEN_REUSED_CODE = 'REFRESH_TOKEN_REUSED'
const REFRESH_TOKEN_REUSED_MESSAGE =
  'Refresh token was already used; the session family has been revoked'

/**
 * A refresh token presented after it was already spent, outside the grace
 * window. The family is revoked before this is thrown.
 *
 * A separate code from `InvalidRefreshTokenError`, and `securityEvent: true`
 * on top of it — decision 15 keeps the use case from logging, so this flag is
 * what makes the error handler emit a `warn` line carrying the code. Folding
 * this into `InvalidRefreshTokenError`, or dropping the flag, would erase the
 * only trace that reuse detection ever fired — the security event this whole
 * design exists to produce. The client also acts differently on the code:
 * this one means "wipe the secure storage and send the user back to the login
 * screen", not "retry".
 */
export class RefreshTokenReusedError extends UnauthorizedError {
  readonly code = REFRESH_TOKEN_REUSED_CODE
  override readonly securityEvent = true

  constructor() {
    super(REFRESH_TOKEN_REUSED_MESSAGE)
  }
}

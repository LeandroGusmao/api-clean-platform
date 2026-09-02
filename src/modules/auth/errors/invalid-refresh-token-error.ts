import { UnauthorizedError } from '#shared/errors/app-error'

const INVALID_REFRESH_TOKEN_CODE = 'INVALID_REFRESH_TOKEN'
const INVALID_REFRESH_TOKEN_MESSAGE = 'Invalid or expired refresh token'

/**
 * The answer to a token that is unknown, expired, or absent. Says nothing about
 * which: a client that knows what it sent gains nothing from the distinction,
 * and an attacker probing values would.
 */
export class InvalidRefreshTokenError extends UnauthorizedError {
  readonly code = INVALID_REFRESH_TOKEN_CODE

  constructor() {
    super(INVALID_REFRESH_TOKEN_MESSAGE)
  }
}

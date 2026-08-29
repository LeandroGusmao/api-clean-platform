import { UnauthorizedError } from '#shared/errors/app-error'

const INVALID_CREDENTIALS_CODE = 'INVALID_CREDENTIALS'
const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials'

/**
 * The single answer to both login failures: no such email, and wrong password.
 *
 * Deliberately says nothing about which. `UserNotFoundError` would report that
 * the account does not exist — account enumeration with no timing needed.
 */
export class InvalidCredentialsError extends UnauthorizedError {
  readonly code = INVALID_CREDENTIALS_CODE

  constructor() {
    super(INVALID_CREDENTIALS_MESSAGE)
  }
}

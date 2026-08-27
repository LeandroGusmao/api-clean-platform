import { ConflictError } from '#shared/errors/app-error'

const EMAIL_ALREADY_IN_USE_CODE = 'EMAIL_ALREADY_IN_USE'
const EMAIL_ALREADY_IN_USE_MESSAGE = 'Email already in use'

/**
 * The email is taken. Raised by the repository, which learns it from the
 * database's unique index rather than from a prior lookup — checking first
 * races.
 *
 * Accepted cost: answering 409 tells a caller the account exists. Without an
 * email provider there is no honest alternative, and the real mitigation is
 * rate limiting, which is still an open decision.
 */
export class EmailAlreadyInUseError extends ConflictError {
  readonly code = EMAIL_ALREADY_IN_USE_CODE

  constructor() {
    super(EMAIL_ALREADY_IN_USE_MESSAGE)
  }
}

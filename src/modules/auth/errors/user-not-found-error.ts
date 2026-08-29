import { NotFoundError } from '#shared/errors/app-error'

const USER_NOT_FOUND_CODE = 'USER_NOT_FOUND'
const USER_NOT_FOUND_MESSAGE = 'User not found'

/**
 * Never raised by login: reporting that an email has no account is enumeration
 * with no timing needed. It belongs to the authenticated paths, where the
 * caller has already proved it holds a token — the account was deleted while a
 * still-unexpired token was in the wild.
 */
export class UserNotFoundError extends NotFoundError {
  readonly code = USER_NOT_FOUND_CODE

  constructor() {
    super(USER_NOT_FOUND_MESSAGE)
  }
}

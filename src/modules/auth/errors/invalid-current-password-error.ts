import { BusinessRuleError } from '#shared/errors/app-error'

const INVALID_CURRENT_PASSWORD_CODE = 'INVALID_CURRENT_PASSWORD'
const INVALID_CURRENT_PASSWORD_MESSAGE = 'Current password is incorrect'

/**
 * The current password did not match, on a route whose caller is already
 * authenticated.
 *
 * A `BusinessRuleError` and not an `UnauthorizedError`, and the reason is
 * client behaviour rather than semantics: every serious mobile interceptor
 * treats 401 as "the access token expired", so it would refresh a perfectly
 * good token, replay the request, take another 401 and — in many interceptors —
 * sign the user out over a typo. 422 is unambiguous: the Bearer was fine, a
 * rule failed.
 *
 * The first concrete `BusinessRuleError` in the project. Until now the 422 row
 * of `STATUS_BY_CATEGORY` was reachable only by the handler's own probe.
 */
export class InvalidCurrentPasswordError extends BusinessRuleError {
  readonly code = INVALID_CURRENT_PASSWORD_CODE

  constructor() {
    super(INVALID_CURRENT_PASSWORD_MESSAGE)
  }
}

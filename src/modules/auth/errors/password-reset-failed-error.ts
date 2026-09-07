import { BusinessRuleError } from '#shared/errors/app-error'

const PASSWORD_RESET_FAILED_CODE = 'PASSWORD_RESET_FAILED'
const PASSWORD_RESET_FAILED_MESSAGE = 'Password reset failed'

/**
 * Every failure mode of a reset: unknown token, expired, already consumed, and
 * losing the race to a concurrent reset. ONE error for all of them, for the
 * reason `email-verification-failed-error.ts` documents — separate branches
 * drift apart at the first maintenance and the oracle comes back.
 *
 * `BusinessRuleError` -> 422: the body is well formed, a rule failed.
 */
export class PasswordResetFailedError extends BusinessRuleError {
  readonly code = PASSWORD_RESET_FAILED_CODE

  constructor() {
    super(PASSWORD_RESET_FAILED_MESSAGE)
  }
}

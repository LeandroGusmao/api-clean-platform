import { BusinessRuleError } from '#shared/errors/app-error'

const EMAIL_VERIFICATION_FAILED_CODE = 'EMAIL_VERIFICATION_FAILED'
const EMAIL_VERIFICATION_FAILED_MESSAGE = 'Email verification failed'

/**
 * Every failure mode of a confirm: unknown email, no active code, expired,
 * attempts exhausted, wrong code, and losing the race to a concurrent confirm.
 *
 * ONE error for all six, for the reason `login-user.ts` documents about its
 * single throw: separate branches start identical and drift apart at the first
 * maintenance — one gains a log, another a message — and the oracle comes back.
 *
 * `BusinessRuleError` → 422 and not 400: the body is well formed (six digits);
 * what failed is a rule. Symmetric with `InvalidCurrentPasswordError` — a wrong
 * secret presented by someone who already identified themselves.
 */
export class EmailVerificationFailedError extends BusinessRuleError {
  readonly code = EMAIL_VERIFICATION_FAILED_CODE

  constructor() {
    super(EMAIL_VERIFICATION_FAILED_MESSAGE)
  }
}

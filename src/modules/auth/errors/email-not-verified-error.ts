import { ForbiddenError } from '#shared/errors/app-error'

const EMAIL_NOT_VERIFIED_CODE = 'EMAIL_NOT_VERIFIED'
const EMAIL_NOT_VERIFIED_MESSAGE = 'Email is not verified'

/**
 * The login gate. Thrown ONLY after the password check has passed, so the
 * "unverified" signal never reaches anyone who does not already know the
 * password — otherwise the gate would reopen the enumeration surface that the
 * decoy hash in `login-user.ts` exists to close.
 *
 * `ForbiddenError` → 403 and not 401: decision 13 glosses 403 as "authenticated,
 * not permitted", which is literally the case once the password has matched. A
 * 401 would also invite a mobile interceptor to loop on refresh, and there is no
 * token to refresh at login.
 */
export class EmailNotVerifiedError extends ForbiddenError {
  readonly code = EMAIL_NOT_VERIFIED_CODE

  constructor() {
    super(EMAIL_NOT_VERIFIED_MESSAGE)
  }
}

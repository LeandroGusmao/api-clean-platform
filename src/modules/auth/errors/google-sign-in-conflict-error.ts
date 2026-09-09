import { ConflictError } from '#shared/errors/app-error'

const GOOGLE_SIGN_IN_CONFLICT_CODE = 'GOOGLE_SIGN_IN_CONFLICT'
const GOOGLE_SIGN_IN_CONFLICT_MESSAGE =
  'This email cannot be linked to this Google account'

/**
 * Google sign-in landed on an email that already belongs to a federated-only
 * account whose provider subject does not match — a Google account that was
 * deleted and recreated, or a second subject for one address over time. There is
 * no password to require and no safe merge, so the sign-in fails. Generic on
 * purpose: no client action resolves it.
 */
export class GoogleSignInConflictError extends ConflictError {
  readonly code = GOOGLE_SIGN_IN_CONFLICT_CODE

  constructor() {
    super(GOOGLE_SIGN_IN_CONFLICT_MESSAGE)
  }
}

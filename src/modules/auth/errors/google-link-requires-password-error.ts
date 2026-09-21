import { ConflictError } from '#shared/errors/app-error'

const GOOGLE_LINK_REQUIRES_PASSWORD_CODE = 'GOOGLE_LINK_REQUIRES_PASSWORD'
const GOOGLE_LINK_REQUIRES_PASSWORD_MESSAGE =
  'This email already has a password account; supply the password to link Google'

/**
 * Google sign-in landed on an email that already has a password account, and no
 * password was supplied to prove ownership.
 *
 * Deliberately specific — "this email already has a password account" — and that
 * is safe here alone: the caller already proved control of the address through
 * Google, so this is not an enumeration oracle. It is the one place in `auth`
 * where telling the truth costs nothing.
 */
export class GoogleLinkRequiresPasswordError extends ConflictError {
  readonly code = GOOGLE_LINK_REQUIRES_PASSWORD_CODE

  constructor() {
    super(GOOGLE_LINK_REQUIRES_PASSWORD_MESSAGE)
  }
}

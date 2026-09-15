import { UnauthorizedError } from '#shared/errors/app-error'

const INVALID_GOOGLE_IDENTITY_CODE = 'INVALID_GOOGLE_IDENTITY'
const INVALID_GOOGLE_IDENTITY_MESSAGE = 'Invalid Google identity token'

/**
 * The single answer to every way a Google ID token can fail: bad signature,
 * wrong issuer, wrong audience, expired, or an email Google has not verified.
 *
 * Deliberately says nothing about which. Branches that reported differently
 * would drift apart at the first maintenance and hand an attacker a probe.
 */
export class InvalidGoogleIdentityError extends UnauthorizedError {
  readonly code = INVALID_GOOGLE_IDENTITY_CODE

  constructor() {
    super(INVALID_GOOGLE_IDENTITY_MESSAGE)
  }
}

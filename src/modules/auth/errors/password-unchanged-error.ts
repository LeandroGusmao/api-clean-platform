import { BusinessRuleError } from '#shared/errors/app-error'

const PASSWORD_UNCHANGED_CODE = 'PASSWORD_UNCHANGED'
const PASSWORD_UNCHANGED_MESSAGE = 'New password must differ from the current one'

/**
 * The new password equals the current one.
 *
 * Without this rule the call would be an expensive no-op that answers success:
 * every session revoked, a new family minted, and the same secret rewritten
 * under a different salt. A user who meant to confirm their password would lose
 * every other device with no explanation.
 *
 * The comparison behind it is plaintext, not a third argon2 — see the use case.
 */
export class PasswordUnchangedError extends BusinessRuleError {
  readonly code = PASSWORD_UNCHANGED_CODE

  constructor() {
    super(PASSWORD_UNCHANGED_MESSAGE)
  }
}

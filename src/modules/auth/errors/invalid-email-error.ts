import { ValidationError } from '#shared/errors/app-error'

const INVALID_EMAIL_CODE = 'INVALID_EMAIL'
const INVALID_EMAIL_MESSAGE_PREFIX = 'Invalid email: '

/**
 * Raised by the `Email` value object. Unreachable over HTTP — the endpoint's
 * Zod schema refuses the same values first — so this exists for the other
 * entrypoints of decision 10: worker, cron, seed.
 */
export class InvalidEmailError extends ValidationError {
  readonly code = INVALID_EMAIL_CODE

  constructor(reason: string) {
    super(`${INVALID_EMAIL_MESSAGE_PREFIX}${reason}`)
  }
}

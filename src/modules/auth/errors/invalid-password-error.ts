import { ValidationError } from '#shared/errors/app-error'

const INVALID_PASSWORD_CODE = 'INVALID_PASSWORD'
const INVALID_PASSWORD_MESSAGE_PREFIX = 'Invalid password: '

/**
 * Raised by the `Password` value object. Like `InvalidEmailError`, unreachable
 * over HTTP and kept for the non-HTTP entrypoints of decision 10.
 *
 * The reason never quotes the value: this message reaches logs.
 */
export class InvalidPasswordError extends ValidationError {
  readonly code = INVALID_PASSWORD_CODE

  constructor(reason: string) {
    super(`${INVALID_PASSWORD_MESSAGE_PREFIX}${reason}`)
  }
}

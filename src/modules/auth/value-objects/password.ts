import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'

/** Policy: the business decides the floor. */
export const MIN_PASSWORD_LENGTH = 8
/** Ceiling so an attacker cannot make argon2 chew on a huge input. */
export const MAX_PASSWORD_LENGTH = 128

/**
 * Letter + digit + non-alphanumeric, in any order.
 *
 * One pattern rather than three `.regex()` calls: three of them emit
 * `INVALID_FORMAT` for all three rules and duplicate entries in the error
 * `details` when more than one fails, leaving the client unable to tell them
 * apart. Verified before this was written.
 *
 * The `s` flag is load-bearing: without it `.` never crosses a newline, and an
 * anchored lookahead would reject `"abc\n123!"` — a password that satisfies the
 * whole policy. A newline is a legitimate password character, like a space.
 *
 * Note: the generated OpenAPI publishes this as `pattern` WITHOUT the flag,
 * because JSON Schema has no notion of regex flags. The published pattern is
 * therefore slightly stricter than the server.
 */
export const PASSWORD_POLICY_PATTERN = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[^a-zA-Z0-9])/s

const TOO_SHORT_REASON = `must be at least ${MIN_PASSWORD_LENGTH} characters`
const TOO_LONG_REASON = `must be at most ${MAX_PASSWORD_LENGTH} characters`
const POLICY_REASON =
  'must contain at least one letter, one digit and one special character'

/**
 * Owns the password POLICY, holding the plaintext only in transit until the
 * application layer hashes it.
 *
 * The plaintext lives in a `#` field, which is non-enumerable:
 * `JSON.stringify(password)` is `{}`, so it cannot leak through logging or
 * serialization. The instance is frozen.
 *
 * Hashing is NOT this object's job — that is a technical capability, and it
 * lives behind `IHashProvider`. This owns the policy, and only the policy.
 */
export class Password {
  readonly #value: string

  private constructor(value: string) {
    this.#value = value
    Object.freeze(this)
  }

  static create(raw: string): Password {
    if (raw.length < MIN_PASSWORD_LENGTH) {
      throw new InvalidPasswordError(TOO_SHORT_REASON)
    }
    if (raw.length > MAX_PASSWORD_LENGTH) {
      throw new InvalidPasswordError(TOO_LONG_REASON)
    }
    if (!PASSWORD_POLICY_PATTERN.test(raw)) {
      throw new InvalidPasswordError(POLICY_REASON)
    }

    return new Password(raw)
  }

  get value(): string {
    return this.#value
  }
}

import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'

/** RFC 5321 upper bound. The column is `text`, so this is the real guard. */
export const MAX_EMAIL_LENGTH = 254

const AT_SIGN = '@'
const WHITESPACE_PATTERN = /\s/

const EMPTY_REASON = 'must not be empty'
const TOO_LONG_REASON = `must be at most ${MAX_EMAIL_LENGTH} characters`
const WHITESPACE_REASON = 'must not contain whitespace'
const MALFORMED_REASON = 'must be a valid email address'

/**
 * Immutable, self-validating, compared by value.
 *
 * `create` normalizes with `trim().toLowerCase()`, which is what makes the
 * stored value always match the functional unique index on `lower(email)` —
 * every lookup must query `lower(email) = $1` to hit that index.
 *
 * Validation is deliberately pragmatic. Full RFC 5322 regexes are notoriously
 * wrong, and real deliverability is proven by email verification, not syntax.
 *
 * Deliberately looser than the HTTP boundary's `z.email()`: this accepts
 * anything with exactly one `@` and non-empty sides (e.g. `a@b`), so the
 * worker/cron/seed entrypoints that call `create` directly can produce rows
 * no HTTP client could have made.
 */
export class Email {
  private constructor(readonly value: string) {
    // `readonly` is compile-time only. The freeze keeps an Email handed out by
    // `user.email` from being corrupted at runtime.
    Object.freeze(this)
  }

  /** Builds from untrusted input: registration, login, a seed file. */
  static create(raw: string): Email {
    const normalized = raw.trim().toLowerCase()

    if (normalized.length === 0) throw new InvalidEmailError(EMPTY_REASON)
    if (normalized.length > MAX_EMAIL_LENGTH) {
      throw new InvalidEmailError(TOO_LONG_REASON)
    }
    // `trim` only strips the edges; an unquoted space anywhere inside is never
    // a valid address.
    if (WHITESPACE_PATTERN.test(normalized)) {
      throw new InvalidEmailError(WHITESPACE_REASON)
    }

    const at = normalized.indexOf(AT_SIGN)
    // Exactly one '@', with a non-empty local part and a non-empty domain.
    if (
      at <= 0 ||
      at !== normalized.lastIndexOf(AT_SIGN) ||
      at === normalized.length - 1
    ) {
      throw new InvalidEmailError(MALFORMED_REASON)
    }

    return new Email(normalized)
  }

  /**
   * Rehydrates a value that was already persisted, and therefore already
   * validated. Skips validation on purpose: re-validating on read would let a
   * future stricter rule break the loading of rows that were valid when
   * written.
   */
  static fromTrusted(value: string): Email {
    return new Email(value)
  }

  equals(other: Email): boolean {
    return this.value === other.value
  }
}

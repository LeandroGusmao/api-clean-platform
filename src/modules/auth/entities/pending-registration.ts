import type { Email } from '#modules/auth/value-objects/email'

/**
 * `Object.freeze` is shallow: it locks the bindings, not the objects behind
 * them. Copying dates in and out is what makes the immutability this class
 * claims actually hold — the same reasoning as in `email-verification.ts`.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

const MILLISECONDS_PER_SECOND = 1000

export interface CreatePendingRegistrationProps {
  id: string
  email: Email
  /** The digest, never the raw code. See `ITokenDigest`. */
  codeHash: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
  ttlSeconds: number
}

/** The complete state of an already-persisted row. See `User.fromTrusted`. */
export interface TrustedPendingRegistrationProps {
  id: string
  email: Email
  codeHash: string
  attempts: number
  codeIssuedAt: Date
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

/**
 * One outstanding six-digit code minted for an email address before any account
 * exists. It carries NO password: the account's
 * password is chosen at confirmation, so whoever registered the address first
 * owns nothing: completing the account takes a code that only reached the
 * owner's inbox.
 *
 * State lives in `#` private fields, non-enumerable at runtime:
 * `JSON.stringify(pending)` yields `{}`, so the digest cannot escape through an
 * accidental `reply.send(pending)` or a stray `log.info({ pending })`.
 *
 * The plaintext code is NEVER here. It exists only in the email being sent;
 * what survives a request is the digest.
 */
export class PendingRegistration {
  readonly #id: string
  readonly #email: Email
  readonly #codeHash: string
  readonly #attempts: number
  readonly #codeIssuedAt: Date
  readonly #expiresAt: Date
  readonly #consumedAt: Date | null
  readonly #createdAt: Date

  private constructor(props: TrustedPendingRegistrationProps) {
    this.#id = props.id
    this.#email = props.email
    this.#codeHash = props.codeHash
    this.#attempts = props.attempts
    this.#codeIssuedAt = cloneDate(props.codeIssuedAt)
    this.#expiresAt = cloneDate(props.expiresAt)
    this.#consumedAt = cloneNullableDate(props.consumedAt)
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  /**
   * Born unconsumed and with no attempts spent. `expiresAt` is derived from the
   * injected clock, not a column default: Postgres stores `timestamptz` in
   * microseconds while a JS `Date` has milliseconds, and `isUsable` compares
   * instants — both sides must come from the same source.
   */
  static create(props: CreatePendingRegistrationProps): PendingRegistration {
    const NO_ATTEMPTS_SPENT = 0

    return new PendingRegistration({
      id: props.id,
      email: props.email,
      codeHash: props.codeHash,
      attempts: NO_ATTEMPTS_SPENT,
      codeIssuedAt: props.now,
      expiresAt: new Date(
        props.now.getTime() + props.ttlSeconds * MILLISECONDS_PER_SECOND,
      ),
      consumedAt: null,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedPendingRegistrationProps): PendingRegistration {
    return new PendingRegistration(props)
  }

  /**
   * Usable = not consumed, not expired, and under the attempt cap. Inclusive at
   * the expiry boundary, like `EmailVerification.isUsable`: an instant that has
   * arrived is spent.
   */
  isUsable(maxAttempts: number, now: Date): boolean {
    return (
      this.#consumedAt === null &&
      this.#expiresAt.getTime() > now.getTime() &&
      this.#attempts < maxAttempts
    )
  }

  /**
   * Takes the DIGEST, never the raw code — hashing is `ITokenDigest`'s job. A
   * plain comparison, not `timingSafeEqual`: what is compared here are two
   * digests, not two secrets, and each wrong guess burns one of the five.
   */
  matches(codeHash: string): boolean {
    return codeHash === this.#codeHash
  }

  get id(): string {
    return this.#id
  }

  get email(): Email {
    return this.#email
  }

  get codeHash(): string {
    return this.#codeHash
  }

  get attempts(): number {
    return this.#attempts
  }

  get codeIssuedAt(): Date {
    return cloneDate(this.#codeIssuedAt)
  }

  get expiresAt(): Date {
    return cloneDate(this.#expiresAt)
  }

  get consumedAt(): Date | null {
    return cloneNullableDate(this.#consumedAt)
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }
}

/**
 * `Object.freeze` is shallow: it locks the bindings on an instance, not the
 * internals of the objects they point at. Copying on the way in and on the way
 * out is what makes the immutability this class claims actually hold — the same
 * reasoning as in `user.ts`.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

const MILLISECONDS_PER_SECOND = 1000

export interface CreateEmailVerificationProps {
  id: string
  userId: string
  /** The digest, never the raw code. See `ITokenDigest`. */
  codeHash: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
  ttlSeconds: number
}

/** The complete state of an already-persisted verification. See `User.fromTrusted`. */
export interface TrustedEmailVerificationProps {
  id: string
  userId: string
  codeHash: string
  expiresAt: Date
  consumedAt: Date | null
  attempts: number
  createdAt: Date
}

/**
 * One outstanding six-digit code minted for a user's email (decision 11's
 * sibling for verification, not rotation).
 *
 * State lives in `#` private fields, which are genuinely private and
 * non-enumerable at runtime: `JSON.stringify(verification)` yields `{}`, so the
 * digest cannot escape through an accidental `reply.send(verification)` or a
 * stray `log.info({ verification })`.
 *
 * The plaintext code is NEVER here. It exists only in the email being sent;
 * what survives a request is the digest.
 */
export class EmailVerification {
  readonly #id: string
  readonly #userId: string
  readonly #codeHash: string
  readonly #expiresAt: Date
  readonly #consumedAt: Date | null
  readonly #attempts: number
  readonly #createdAt: Date

  private constructor(props: TrustedEmailVerificationProps) {
    this.#id = props.id
    this.#userId = props.userId
    this.#codeHash = props.codeHash
    this.#expiresAt = cloneDate(props.expiresAt)
    this.#consumedAt = cloneNullableDate(props.consumedAt)
    this.#attempts = props.attempts
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  /**
   * Born unconsumed and with no attempts spent. `expiresAt` is derived from the
   * injected clock rather than from a column default: Postgres stores
   * `timestamptz` in microseconds while a JS `Date` has milliseconds, and the
   * usability check compares instants — so both sides of every comparison have
   * to come from the same source (decision 11).
   */
  static create(props: CreateEmailVerificationProps): EmailVerification {
    const NO_ATTEMPTS_SPENT = 0

    return new EmailVerification({
      id: props.id,
      userId: props.userId,
      codeHash: props.codeHash,
      // `new Date(millis)` is deterministic, so it is not the R7 hazard that
      // `new Date()` with no argument is.
      expiresAt: new Date(
        props.now.getTime() + props.ttlSeconds * MILLISECONDS_PER_SECOND,
      ),
      consumedAt: null,
      attempts: NO_ATTEMPTS_SPENT,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedEmailVerificationProps): EmailVerification {
    return new EmailVerification(props)
  }

  /**
   * Usable = not consumed, not expired, and under the attempt cap.
   *
   * Inclusive at the expiry boundary, like `RefreshToken.isExpired`: an instant
   * that has arrived is spent.
   */
  isUsable(maxAttempts: number, now: Date): boolean {
    return (
      this.#consumedAt === null &&
      this.#expiresAt.getTime() > now.getTime() &&
      this.#attempts < maxAttempts
    )
  }

  /**
   * Takes the DIGEST, never the raw code. That is what keeps this entity free of
   * ports and of `node:crypto` — hashing is `ITokenDigest`'s job, and the use
   * case does `verification.matches(tokenDigest.hash(command.code))`.
   *
   * A plain comparison, not `timingSafeEqual`, deliberately: what is compared
   * here are two digests, not two secrets. Exploiting the timing leak would mean
   * forging a code whose sha256 shares a prefix with the stored one — and each
   * attempt burns one of the five the cap allows.
   */
  matches(codeHash: string): boolean {
    return codeHash === this.#codeHash
  }

  get id(): string {
    return this.#id
  }

  get userId(): string {
    return this.#userId
  }

  get codeHash(): string {
    return this.#codeHash
  }

  get expiresAt(): Date {
    return cloneDate(this.#expiresAt)
  }

  get consumedAt(): Date | null {
    return cloneNullableDate(this.#consumedAt)
  }

  get attempts(): number {
    return this.#attempts
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }
}

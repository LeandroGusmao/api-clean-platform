function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

const MILLISECONDS_PER_SECOND = 1000

export interface CreatePasswordResetTokenProps {
  id: string
  userId: string
  /** The digest, never the raw token. See `ITokenDigest`. */
  tokenHash: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
  ttlSeconds: number
}

/** The complete state of an already-persisted row. See `PendingRegistration.fromTrusted`. */
export interface TrustedPasswordResetTokenProps {
  id: string
  userId: string
  tokenHash: string
  issuedAt: Date
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

/**
 * One outstanding reset token for an account that already exists. It carries no
 * password: the new password arrives in the reset request. State lives in `#`
 * private fields, non-enumerable at runtime, so `JSON.stringify(token)` is `{}`
 * and the digest cannot escape through an accidental `reply.send` or a stray
 * log. The plaintext token is NEVER here — it exists only in the email.
 */
export class PasswordResetToken {
  readonly #id: string
  readonly #userId: string
  readonly #tokenHash: string
  readonly #issuedAt: Date
  readonly #expiresAt: Date
  readonly #consumedAt: Date | null
  readonly #createdAt: Date

  private constructor(props: TrustedPasswordResetTokenProps) {
    this.#id = props.id
    this.#userId = props.userId
    this.#tokenHash = props.tokenHash
    this.#issuedAt = cloneDate(props.issuedAt)
    this.#expiresAt = cloneDate(props.expiresAt)
    this.#consumedAt = cloneNullableDate(props.consumedAt)
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  /**
   * Born unconsumed. `expiresAt` comes from the injected clock plus the ttl,
   * not a column default: `isUsable` compares instants and both sides must
   * share a source.
   *
   * Kept for symmetry with `PendingRegistration.create`; production
   * writes go through the adapter's column mapping, so only tests construct via
   * this path.
   */
  static create(props: CreatePasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken({
      id: props.id,
      userId: props.userId,
      tokenHash: props.tokenHash,
      issuedAt: props.now,
      expiresAt: new Date(
        props.now.getTime() + props.ttlSeconds * MILLISECONDS_PER_SECOND,
      ),
      consumedAt: null,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedPasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken(props)
  }

  /**
   * Usable = not consumed and not expired. Inclusive at the expiry boundary,
   * like `PendingRegistration.isUsable`: an instant that has arrived is spent.
   */
  isUsable(now: Date): boolean {
    return this.#consumedAt === null && this.#expiresAt.getTime() > now.getTime()
  }

  get id(): string {
    return this.#id
  }

  get userId(): string {
    return this.#userId
  }

  get tokenHash(): string {
    return this.#tokenHash
  }

  get issuedAt(): Date {
    return cloneDate(this.#issuedAt)
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

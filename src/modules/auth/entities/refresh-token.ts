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

export interface CreateRefreshTokenProps {
  id: string
  userId: string
  /** The digest, never the token itself. See `ITokenDigest`. */
  tokenHash: string
  /** The chain this token belongs to. A login starts a new one. */
  familyId: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
  ttlSeconds: number
  /** The request that created this row. Null only on a row older than the column. */
  ip: string | null
  /** Names the device, not the request, so rotation inherits it. */
  deviceLabel: string | null
  /** When the family opened. Rotation inherits it, having discarded the row that knew it. */
  sessionStartedAt: Date | null
}

/** The complete state of an already-persisted token. See `User.fromTrusted`. */
export interface TrustedRefreshTokenProps {
  id: string
  userId: string
  tokenHash: string
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
  replacedBy: string | null
  createdAt: Date
  ip: string | null
  deviceLabel: string | null
  sessionStartedAt: Date | null
}

/**
 * One link in a rotating refresh chain (decision 11).
 *
 * State lives in `#` private fields, which are genuinely private and
 * non-enumerable at runtime: `JSON.stringify(token)` yields `{}`, so the digest
 * cannot escape through an accidental `reply.send(token)` or a stray
 * `log.info({ token })`.
 *
 * The plaintext token is NEVER here. It exists only in the response being
 * built; what survives a request is the digest.
 */
export class RefreshToken {
  readonly #id: string
  readonly #userId: string
  readonly #tokenHash: string
  readonly #familyId: string
  readonly #expiresAt: Date
  readonly #revokedAt: Date | null
  readonly #replacedBy: string | null
  readonly #createdAt: Date
  readonly #ip: string | null
  readonly #deviceLabel: string | null
  readonly #sessionStartedAt: Date | null

  private constructor(props: TrustedRefreshTokenProps) {
    this.#id = props.id
    this.#userId = props.userId
    this.#tokenHash = props.tokenHash
    this.#familyId = props.familyId
    this.#expiresAt = cloneDate(props.expiresAt)
    this.#revokedAt = cloneNullableDate(props.revokedAt)
    this.#replacedBy = props.replacedBy
    this.#createdAt = cloneDate(props.createdAt)
    this.#ip = props.ip
    this.#deviceLabel = props.deviceLabel
    this.#sessionStartedAt = cloneNullableDate(props.sessionStartedAt)
    Object.freeze(this)
  }

  /**
   * Born active. `expiresAt` is derived from the injected clock rather than
   * from a column default: Postgres stores `timestamptz` in microseconds while
   * a JS `Date` has milliseconds, and the grace window compares instants — so
   * both sides of every comparison have to come from the same source
   * (decision 11).
   */
  static create(props: CreateRefreshTokenProps): RefreshToken {
    return new RefreshToken({
      id: props.id,
      userId: props.userId,
      tokenHash: props.tokenHash,
      familyId: props.familyId,
      // `new Date(millis)` is deterministic, so it is not the R7 hazard that
      // `new Date()` with no argument is.
      expiresAt: new Date(
        props.now.getTime() + props.ttlSeconds * MILLISECONDS_PER_SECOND,
      ),
      revokedAt: null,
      replacedBy: null,
      createdAt: props.now,
      ip: props.ip,
      deviceLabel: props.deviceLabel,
      sessionStartedAt: props.sessionStartedAt,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedRefreshTokenProps): RefreshToken {
    return new RefreshToken(props)
  }

  /** Inclusive at the boundary: an instant that has arrived is spent. */
  isExpired(now: Date): boolean {
    return this.#expiresAt.getTime() <= now.getTime()
  }

  isRevoked(): boolean {
    return this.#revokedAt !== null
  }

  /**
   * True when this token was revoked BY ROTATION and recently enough to be the
   * retry of a response that got lost — the mobile case decision 11 describes:
   * the phone sends the refresh, the server rotates and answers, the answer
   * dies in a tunnel, and the app retries with the token it still has.
   *
   * `replacedBy` is the load-bearing half. A token revoked by LOGOUT carries
   * none, and must never land here: handing it a fresh pair would make this
   * window a bypass of explicit revocation.
   */
  isWithinGraceWindow(now: Date, graceWindowMs: number): boolean {
    if (this.#revokedAt === null || this.#replacedBy === null) return false

    return now.getTime() - this.#revokedAt.getTime() <= graceWindowMs
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

  get familyId(): string {
    return this.#familyId
  }

  get expiresAt(): Date {
    return cloneDate(this.#expiresAt)
  }

  get revokedAt(): Date | null {
    return cloneNullableDate(this.#revokedAt)
  }

  get replacedBy(): string | null {
    return this.#replacedBy
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }

  get ip(): string | null {
    return this.#ip
  }

  get deviceLabel(): string | null {
    return this.#deviceLabel
  }

  get sessionStartedAt(): Date | null {
    return cloneNullableDate(this.#sessionStartedAt)
  }
}

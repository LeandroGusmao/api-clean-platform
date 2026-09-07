import type { Email } from '#modules/auth/value-objects/email'

/**
 * `Object.freeze` is shallow: it locks the bindings on an instance, not the
 * internals of the objects they point at. A `Date` handed out by a getter stays
 * mutable, so `user.createdAt.setFullYear(1970)` would rewrite the entity's own
 * state. Copying on the way in and on the way out is what makes the
 * immutability this class claims actually hold.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

export interface CreateUserProps {
  id: string
  email: Email
  passwordHash: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
}

/**
 * The complete state of an already-persisted user. Named for the same reason as
 * `Email.fromTrusted`: the row was validated when it was written, and
 * re-validating on read would let a future stricter rule break the loading of
 * rows that were valid at the time.
 */
export interface TrustedUserProps {
  id: string
  email: Email
  passwordHash: string
  emailVerifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * An application user's credentials.
 *
 * State lives in `#` private fields, which are genuinely private and
 * non-enumerable at runtime: `JSON.stringify(user)` yields `{}`, so the
 * password hash cannot escape through an accidental `reply.send(user)` or a
 * stray `log.info({ user })`.
 *
 * The entity does not know the shape of a database row — converting is
 * `infra/drizzle/user-mapper.ts`'s job (decision 20).
 */
export class User {
  readonly #id: string
  readonly #email: Email
  readonly #passwordHash: string
  readonly #emailVerifiedAt: Date | null
  readonly #createdAt: Date
  readonly #updatedAt: Date

  private constructor(props: TrustedUserProps) {
    this.#id = props.id
    this.#email = props.email
    this.#passwordHash = props.passwordHash
    this.#emailVerifiedAt = cloneNullableDate(props.emailVerifiedAt)
    this.#createdAt = cloneDate(props.createdAt)
    this.#updatedAt = cloneDate(props.updatedAt)
    Object.freeze(this)
  }

  /**
   * Born **verified**: since slice 11 the only path that reaches `create` is
   * `ConfirmEmailUseCase`, which has already proven control of the address
   * (§5.5 of the slice 11 design). Social login, when it lands, is the other
   * proven path. `fromTrusted` still accepts a null `email_verified_at` for old
   * rows and for any unverified path a later slice reintroduces.
   *
   * The domain owns the id and the timestamps, so the row is complete before
   * the insert. The schema defaults (`defaultRandom` / `defaultNow`) are only
   * defense-in-depth for direct writes: seeds, psql, data migrations.
   */
  static create(props: CreateUserProps): User {
    return new User({
      id: props.id,
      email: props.email,
      passwordHash: props.passwordHash,
      emailVerifiedAt: props.now,
      createdAt: props.now,
      updatedAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedUserProps): User {
    return new User(props)
  }

  get id(): string {
    return this.#id
  }

  get email(): Email {
    return this.#email
  }

  get passwordHash(): string {
    return this.#passwordHash
  }

  get emailVerifiedAt(): Date | null {
    return cloneNullableDate(this.#emailVerifiedAt)
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }

  get updatedAt(): Date {
    return cloneDate(this.#updatedAt)
  }
}

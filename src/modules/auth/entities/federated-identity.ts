import type { Email } from '#modules/auth/value-objects/email'

/**
 * `Object.freeze` is shallow: it locks the bindings, not the objects behind
 * them. Copying dates in and out is what makes the immutability this class
 * claims actually hold — the same reasoning as in `pending-registration.ts`.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

/** The identity providers this module federates with. A closed set. */
export type FederatedProvider = 'google'

/** The only provider wired today. Read by the use case and the repository. */
export const GOOGLE_PROVIDER: FederatedProvider = 'google'

export interface CreateFederatedIdentityProps {
  id: string
  userId: string
  provider: FederatedProvider
  /** The provider's stable subject id — Google's `sub`. */
  providerUserId: string
  /** The address the provider asserted when the link was made. */
  emailAtLink: Email
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
}

/** The complete state of an already-persisted row. See `User.fromTrusted`. */
export interface TrustedFederatedIdentityProps {
  id: string
  userId: string
  provider: FederatedProvider
  providerUserId: string
  emailAtLink: Email
  createdAt: Date
}

/**
 * A link between a local user and an identity a provider vouches for. It is a
 * recorded fact: it does not expire, and nothing about it changes after the
 * insert — unlinking, when it lands, is a row delete.
 *
 * State lives in `#` private fields, non-enumerable at runtime:
 * `JSON.stringify(identity)` yields `{}`, so `providerUserId` cannot escape
 * through an accidental `reply.send(identity)` or `log.info({ identity })`.
 */
export class FederatedIdentity {
  readonly #id: string
  readonly #userId: string
  readonly #provider: FederatedProvider
  readonly #providerUserId: string
  readonly #emailAtLink: Email
  readonly #createdAt: Date

  private constructor(props: TrustedFederatedIdentityProps) {
    this.#id = props.id
    this.#userId = props.userId
    this.#provider = props.provider
    this.#providerUserId = props.providerUserId
    this.#emailAtLink = props.emailAtLink
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  static create(props: CreateFederatedIdentityProps): FederatedIdentity {
    return new FederatedIdentity({
      id: props.id,
      userId: props.userId,
      provider: props.provider,
      providerUserId: props.providerUserId,
      emailAtLink: props.emailAtLink,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedFederatedIdentityProps): FederatedIdentity {
    return new FederatedIdentity(props)
  }

  get id(): string {
    return this.#id
  }

  get userId(): string {
    return this.#userId
  }

  get provider(): FederatedProvider {
    return this.#provider
  }

  get providerUserId(): string {
    return this.#providerUserId
  }

  get emailAtLink(): Email {
    return this.#emailAtLink
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }
}

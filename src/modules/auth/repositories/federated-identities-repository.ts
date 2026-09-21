import type {
  FederatedIdentity,
  FederatedProvider,
} from '#modules/auth/entities/federated-identity'

export interface IFederatedIdentitiesRepository {
  /**
   * Plain insert. A unique violation on `(provider, provider_user_id)` or
   * `(user_id, provider)` bubbles as a generic persistence failure — the
   * concurrent double-link is rare and re-running the sign-in lands on the fast
   * path, so there is nothing to translate.
   */
  save(identity: FederatedIdentity): Promise<void>

  /**
   * The fast path: an already-linked provider identity. Matches on the stable
   * `provider_user_id`, never on the email — the email may have changed since
   * the link was made.
   */
  findByProviderUserId(
    provider: FederatedProvider,
    providerUserId: string,
  ): Promise<FederatedIdentity | null>
}

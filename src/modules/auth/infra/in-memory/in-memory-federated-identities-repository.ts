import type {
  FederatedIdentity,
  FederatedProvider,
} from '#modules/auth/entities/federated-identity'
import type { IFederatedIdentitiesRepository } from '#modules/auth/repositories/federated-identities-repository'

/**
 * In-memory adapter, for the unit tests of the use cases. Models
 * no unique constraint: a unit test inserts one row at a time, and the two
 * unique indexes are proved against real Postgres in
 * `tests/integration/drizzle-federated-identities-repository.spec.ts`.
 */
export class InMemoryFederatedIdentitiesRepository
  implements IFederatedIdentitiesRepository
{
  readonly rows: FederatedIdentity[] = []

  async save(identity: FederatedIdentity): Promise<void> {
    this.rows.push(identity)
  }

  async findByProviderUserId(
    provider: FederatedProvider,
    providerUserId: string,
  ): Promise<FederatedIdentity | null> {
    return (
      this.rows.find(
        (row) => row.provider === provider && row.providerUserId === providerUserId,
      ) ?? null
    )
  }
}

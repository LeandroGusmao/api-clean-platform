import { and, eq } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type {
  FederatedIdentity,
  FederatedProvider,
} from '#modules/auth/entities/federated-identity'
import type { IFederatedIdentitiesRepository } from '#modules/auth/repositories/federated-identities-repository'
import {
  toDomainFederatedIdentity,
  toPersistenceFederatedIdentity,
} from './federated-identity-mapper.js'
import { federatedIdentities } from './schema/federated-identities.js'

export class DrizzleFederatedIdentitiesRepository
  implements IFederatedIdentitiesRepository
{
  constructor(private readonly db: Database) {}

  async save(identity: FederatedIdentity): Promise<void> {
    try {
      await this.db
        .insert(federatedIdentities)
        .values(toPersistenceFederatedIdentity(identity))
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message.
      throw toPersistenceError(error)
    }
  }

  async findByProviderUserId(
    provider: FederatedProvider,
    providerUserId: string,
  ): Promise<FederatedIdentity | null> {
    try {
      const [row] = await this.db
        .select()
        .from(federatedIdentities)
        .where(
          and(
            eq(federatedIdentities.provider, provider),
            eq(federatedIdentities.providerUserId, providerUserId),
          ),
        )

      return row === undefined ? null : toDomainFederatedIdentity(row)
    } catch (error) {
      throw toPersistenceError(error)
    }
  }
}

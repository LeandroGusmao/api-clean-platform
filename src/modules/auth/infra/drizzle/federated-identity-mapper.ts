import {
  FederatedIdentity,
  type FederatedProvider,
} from '#modules/auth/entities/federated-identity'
import { Email } from '#modules/auth/value-objects/email'
import type { federatedIdentities } from './schema/federated-identities.js'

type NewFederatedIdentityRow = typeof federatedIdentities.$inferInsert
type FederatedIdentityRow = typeof federatedIdentities.$inferSelect

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like (decision 20).
 */
export const toPersistenceFederatedIdentity = (
  identity: FederatedIdentity,
): NewFederatedIdentityRow => ({
  id: identity.id,
  userId: identity.userId,
  provider: identity.provider,
  providerUserId: identity.providerUserId,
  emailAtLink: identity.emailAtLink.value,
  createdAt: identity.createdAt,
})

/** Row to entity. Rehydrates rather than validates — see `FederatedIdentity.fromTrusted`. */
export const toDomainFederatedIdentity = (row: FederatedIdentityRow): FederatedIdentity =>
  FederatedIdentity.fromTrusted({
    id: row.id,
    userId: row.userId,
    // The column is unconstrained `text`; the domain type is the closed set.
    provider: row.provider as FederatedProvider,
    providerUserId: row.providerUserId,
    emailAtLink: Email.fromTrusted(row.emailAtLink),
    createdAt: row.createdAt,
  })

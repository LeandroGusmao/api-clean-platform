import { sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { Sha256TokenDigest } from '#infra/providers/sha256-token-digest'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'
import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { User } from '#modules/auth/entities/user'
import { DrizzleFederatedIdentitiesRepository } from '#modules/auth/infra/drizzle/drizzle-federated-identities-repository'
import { DrizzlePendingRegistrationsRepository } from '#modules/auth/infra/drizzle/drizzle-pending-registrations-repository'
import { DrizzleUsersRepository } from '#modules/auth/infra/drizzle/drizzle-users-repository'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Email } from '#modules/auth/value-objects/email'

/** Every seed address lives under this domain, and the wipe below deletes by it. */
export const SEED_EMAIL_DOMAIN = 'seed.local'

/** What `authSeedModule.prepare` computes once, outside the transaction. */
export interface AuthSeedPreparation {
  readonly passwordHash: string
}

const LIKE_ANY_PREFIX = '%@'

const ids = new UuidIdGenerator()
const tokenDigest = new Sha256TokenDigest()

/**
 * Every write goes through the entity and the Drizzle repository the API uses
 * (design §3.2), so a seeded row satisfies the same invariants and mapper as a
 * registered one.
 */
export async function createPasswordUser(
  tx: Database,
  params: { email: string; passwordHash: string; now: Date },
): Promise<User> {
  const user = User.create({
    id: ids.generate(),
    email: Email.create(params.email),
    passwordHash: params.passwordHash,
    now: params.now,
  })
  await new DrizzleUsersRepository(tx).save(user)
  return user
}

export async function createGoogleUser(
  tx: Database,
  params: { email: string; providerUserId: string; now: Date },
): Promise<User> {
  const user = User.createFederated({
    id: ids.generate(),
    email: Email.create(params.email),
    now: params.now,
  })
  await new DrizzleUsersRepository(tx).save(user)
  await new DrizzleFederatedIdentitiesRepository(tx).save(
    FederatedIdentity.create({
      id: ids.generate(),
      userId: user.id,
      provider: GOOGLE_PROVIDER,
      providerUserId: params.providerUserId,
      emailAtLink: user.email,
      now: params.now,
    }),
  )
  return user
}

export async function createPendingRegistration(
  tx: Database,
  params: { email: string; code: string; ttlSeconds: number; now: Date },
): Promise<void> {
  await new DrizzlePendingRegistrationsRepository(tx).save(
    PendingRegistration.create({
      id: ids.generate(),
      email: Email.create(params.email),
      codeHash: tokenDigest.hash(params.code),
      now: params.now,
      ttlSeconds: params.ttlSeconds,
    }),
  )
}

/**
 * The one raw write of the seed: the repositories have no delete-by-domain, and
 * production code has no reason to. `refresh_tokens`, `federated_identities`
 * and `password_reset_tokens` go with `users` by cascade;
 * `pending_registrations` has no foreign key and is deleted explicitly.
 */
export async function wipeAuthSeedNamespace(tx: Database): Promise<void> {
  const pattern = `${LIKE_ANY_PREFIX}${SEED_EMAIL_DOMAIN}`
  await tx.delete(users).where(sql`lower(${users.email}) like ${pattern}`)
  await tx
    .delete(pendingRegistrations)
    .where(sql`lower(${pendingRegistrations.email}) like ${pattern}`)
}

import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { DrizzleFederatedIdentitiesRepository } from '#modules/auth/infra/drizzle/drizzle-federated-identities-repository'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Email } from '#modules/auth/value-objects/email'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_ROW_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const SUBJECT = 'google-subject-1234567890'
const EMAIL = 'ana@example.com'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-09-08T12:00:00.000Z')

let db: Database
let pool: Pool
let repo: DrizzleFederatedIdentitiesRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repo = new DrizzleFederatedIdentitiesRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(federatedIdentities)
  await db.delete(users)
  await db.insert(users).values({
    id: USER_ID,
    email: EMAIL,
    passwordHash: HASH,
    emailVerifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  })
})

const identity = (id = ROW_ID, subject = SUBJECT) =>
  FederatedIdentity.create({
    id,
    userId: USER_ID,
    provider: GOOGLE_PROVIDER,
    providerUserId: subject,
    emailAtLink: Email.fromTrusted(EMAIL),
    now: NOW,
  })

describe('DrizzleFederatedIdentitiesRepository.save', () => {
  it('persists a link, round-tripping through findByProviderUserId', async () => {
    await repo.save(identity())

    const found = await repo.findByProviderUserId(GOOGLE_PROVIDER, SUBJECT)

    expect(found?.id).toBe(ROW_ID)
    expect(found?.userId).toBe(USER_ID)
    expect(found?.providerUserId).toBe(SUBJECT)
    expect(found?.emailAtLink.value).toBe(EMAIL)
  })

  it('rejects a duplicate (provider, subject) as a persistence failure', async () => {
    await repo.save(identity())

    await expect(repo.save(identity(OTHER_ROW_ID))).rejects.toThrow()
  })

  it('rejects a second Google link for the same user', async () => {
    await repo.save(identity())

    await expect(
      repo.save(identity(OTHER_ROW_ID, 'a-different-subject')),
    ).rejects.toThrow()
  })
})

describe('DrizzleFederatedIdentitiesRepository.findByProviderUserId', () => {
  it('returns null when nothing is linked', async () => {
    expect(await repo.findByProviderUserId(GOOGLE_PROVIDER, SUBJECT)).toBeNull()
  })
})

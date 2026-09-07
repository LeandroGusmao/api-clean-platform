import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { LogoutAllUseCase } from '#modules/auth/use-cases/logout-all'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const OTHER_USER_ID = '8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0'
const PHONE_FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const TABLET_FAMILY_ID = '99990000-1111-4222-8333-444455556666'
const STRANGER_FAMILY_ID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'
const PHONE_ID = 'phone'
const TABLET_ID = 'tablet'
const STRANGER_ID = 'stranger'

const NOW = new Date('2026-08-31T12:00:00.000Z')
const LATER = new Date('2026-08-31T12:05:00.000Z')
const TTL_SECONDS = 3600

const NO_USERS = {
  save: async () => {},
  findByEmail: async () => null,
  findById: async () => null,
  updatePasswordHash: async () => {},
  markEmailVerified: async () => {},
}

/** Nothing here reads pending registrations; the shape only satisfies AuthRepos. */
const NO_PENDING_REGISTRATIONS = {
  save: async () => {},
  findUnconsumedByEmail: async () => [],
  reissueCode: async () => {},
  registerFailedAttempt: async () => false,
  consume: async () => false,
  deleteExpiredByEmail: async () => {},
}

/** Nothing here reads password reset tokens; the shape only satisfies AuthRepos. */
const NO_PASSWORD_RESET_TOKENS = {
  issueOrRefresh: async () => true,
  findByHash: async () => null,
  consume: async () => false,
}

let repository: InMemoryRefreshTokensRepository
let useCase: LogoutAllUseCase
let clockReading: Date

const makeUow =
  (repos: AuthRepos): IAuthUnitOfWork =>
  (work) =>
    work(repos)

const store = (id: string, userId: string, familyId: string) =>
  repository.tokens.push(
    RefreshToken.create({
      id,
      userId,
      tokenHash: `digest:${id}`,
      familyId,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
    }),
  )

const revokedAtOf = (id: string) =>
  repository.tokens.find((token) => token.id === id)?.revokedAt

beforeEach(() => {
  clockReading = NOW
  repository = new InMemoryRefreshTokensRepository()
  useCase = new LogoutAllUseCase(
    makeUow({
      users: NO_USERS,
      refreshTokens: repository,
      pendingRegistrations: NO_PENDING_REGISTRATIONS,
      passwordResetTokens: NO_PASSWORD_RESET_TOKENS,
    }),
    {
      now: () => clockReading,
    },
  )
})

describe('LogoutAllUseCase', () => {
  it('revokes every family of the user, across devices', async () => {
    store(PHONE_ID, USER_ID, PHONE_FAMILY_ID)
    store(TABLET_ID, USER_ID, TABLET_FAMILY_ID)

    await useCase.execute(USER_ID)

    expect(revokedAtOf(PHONE_ID)).toEqual(NOW)
    expect(revokedAtOf(TABLET_ID)).toEqual(NOW)
  })

  it('never touches another user session', async () => {
    // The id comes from a verified access token, but a scoping mistake here
    // would sign the whole install base out, and no test above would notice.
    store(PHONE_ID, USER_ID, PHONE_FAMILY_ID)
    store(STRANGER_ID, OTHER_USER_ID, STRANGER_FAMILY_ID)

    await useCase.execute(USER_ID)

    expect(revokedAtOf(STRANGER_ID)).toBeNull()
  })

  it('does not throw for a user with no tokens at all', async () => {
    await expect(useCase.execute(USER_ID)).resolves.toBeUndefined()
  })

  it('does not push an already-revoked token forward', async () => {
    store(PHONE_ID, USER_ID, PHONE_FAMILY_ID)

    await useCase.execute(USER_ID)
    clockReading = LATER
    await useCase.execute(USER_ID)

    expect(revokedAtOf(PHONE_ID)).toEqual(NOW)
  })
})

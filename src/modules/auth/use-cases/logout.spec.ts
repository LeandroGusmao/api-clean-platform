import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { LogoutUseCase } from '#modules/auth/use-cases/logout'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const OTHER_FAMILY_ID = '99990000-1111-4222-8333-444455556666'
const TOKEN = 'the-presented-token'
const SIBLING_TOKEN = 'a-sibling-in-the-same-family'
const UNKNOWN_TOKEN = 'never-issued'
const PRESENTED_ID = 'presented'
const SIBLING_ID = 'sibling'
const OTHER_ID = 'other'

const NOW = new Date('2026-08-31T12:00:00.000Z')
const LATER = new Date('2026-08-31T12:05:00.000Z')
const TTL_SECONDS = 3600

const digestOf = (value: string) => `digest:${value}`

const NO_USERS = {
  save: async () => {},
  findByEmail: async () => null,
  findById: async () => null,
  updatePasswordHash: async () => {},
  markEmailVerified: async () => {},
}

/** Nothing in this suite reads email verifications; the shape only has to satisfy AuthRepos. */
const NO_EMAIL_VERIFICATIONS = {
  save: async () => {},
  findActiveByUserId: async () => null,
  invalidateActiveForUser: async () => {},
  registerFailedAttempt: async () => false,
  consume: async () => false,
}

/** Same: nothing here reads pending registrations, the shape only satisfies AuthRepos. */
const NO_PENDING_REGISTRATIONS = {
  save: async () => {},
  findUnconsumedByEmail: async () => [],
  reissueCode: async () => {},
  registerFailedAttempt: async () => false,
  consume: async () => false,
  deleteExpiredByEmail: async () => {},
}

let repository: InMemoryRefreshTokensRepository
let useCase: LogoutUseCase
let clockReading: Date

const makeUow =
  (repos: AuthRepos): IAuthUnitOfWork =>
  (work) =>
    work(repos)

const store = (id: string, token: string, familyId: string) =>
  repository.tokens.push(
    RefreshToken.create({
      id,
      userId: USER_ID,
      tokenHash: digestOf(token),
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
  useCase = new LogoutUseCase(
    makeUow({
      users: NO_USERS,
      refreshTokens: repository,
      emailVerifications: NO_EMAIL_VERIFICATIONS,
      pendingRegistrations: NO_PENDING_REGISTRATIONS,
    }),
    { hash: digestOf },
    { now: () => clockReading },
  )
})

describe('LogoutUseCase', () => {
  it('revokes the WHOLE family, not just the presented token', async () => {
    // The presented token is not necessarily the live one: a client may log out
    // holding a token that was already rotated. Revoking only that row would
    // leave its successor standing, and the session with it.
    store(PRESENTED_ID, TOKEN, FAMILY_ID)
    store(SIBLING_ID, SIBLING_TOKEN, FAMILY_ID)

    await useCase.execute({ refreshToken: TOKEN })

    expect(revokedAtOf(PRESENTED_ID)).toEqual(NOW)
    expect(revokedAtOf(SIBLING_ID)).toEqual(NOW)
  })

  it('leaves another family of the same user signed in', async () => {
    // Logging out on the phone must not sign the tablet out.
    store(PRESENTED_ID, TOKEN, FAMILY_ID)
    store(OTHER_ID, SIBLING_TOKEN, OTHER_FAMILY_ID)

    await useCase.execute({ refreshToken: TOKEN })

    expect(revokedAtOf(OTHER_ID)).toBeNull()
  })

  it('does not throw for a token it has never seen', async () => {
    // Saying "that token does not exist" is a free oracle, and logout has
    // nothing to protect beyond being idempotent.
    await expect(
      useCase.execute({ refreshToken: UNKNOWN_TOKEN }),
    ).resolves.toBeUndefined()
  })

  it('is idempotent, and does not push the revocation forward', async () => {
    store(PRESENTED_ID, TOKEN, FAMILY_ID)

    await useCase.execute({ refreshToken: TOKEN })
    clockReading = LATER
    await expect(useCase.execute({ refreshToken: TOKEN })).resolves.toBeUndefined()

    expect(revokedAtOf(PRESENTED_ID)).toEqual(NOW)
  })
})

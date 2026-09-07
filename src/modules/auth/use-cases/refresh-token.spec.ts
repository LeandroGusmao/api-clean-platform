import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InvalidRefreshTokenError } from '#modules/auth/errors/invalid-refresh-token-error'
import { RefreshTokenReusedError } from '#modules/auth/errors/refresh-token-reused-error'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { RefreshTokenUseCase } from '#modules/auth/use-cases/refresh-token'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const OTHER_FAMILY_ID = '99990000-1111-4222-8333-444455556666'
const CURRENT_TOKEN = 'current-opaque-token'
const UNKNOWN_TOKEN = 'never-issued-token'
const ACCESS_TOKEN = 'signed.access.token'
const CURRENT_ID = 'current-id'
const SUCCESSOR_ID = 'successor-id'
const OTHER_FAMILY_TOKEN_ID = 'other-family-token'
/** Unused by this suite; required only to satisfy `ITokenGenerator`. */
const NUMERIC_CODE = '000000'

const NOW = new Date('2026-08-31T12:00:00.000Z')
const MILLISECONDS_PER_SECOND = 1000
const TTL_SECONDS = 3600
const TTL_MS = TTL_SECONDS * MILLISECONDS_PER_SECOND
const GRACE_WINDOW_MS = 30_000
const ONE_MILLISECOND = 1
const NO_TOKENS = 0

const digestOf = (value: string) => `digest:${value}`
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

/** Nothing in this suite reads users; the shape only has to satisfy AuthRepos. */
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

/**
 * Passthrough, exactly like the unit of work fake of slice 4: it runs the
 * callback against the same repositories and models NO rollback and NO row
 * lock. Anything that needs either is proved against real Postgres.
 */
const makeUow =
  (repos: AuthRepos): IAuthUnitOfWork =>
  (work) =>
    work(repos)

let repository: InMemoryRefreshTokensRepository
let useCase: RefreshTokenUseCase
let clockReading: Date

const build = () => {
  repository = new InMemoryRefreshTokensRepository()

  // Counted rather than random, so every assertion below is deterministic.
  let generated = 0
  const nextValue = () => {
    generated += 1
    return generated
  }

  const issuer = new RefreshTokenIssuer(
    { opaque: () => `opaque-${nextValue()}`, numericCode: () => NUMERIC_CODE },
    { hash: digestOf },
    { generate: () => `id-${nextValue()}` },
    TTL_SECONDS,
  )

  useCase = new RefreshTokenUseCase(
    makeUow({
      users: NO_USERS,
      refreshTokens: repository,
      emailVerifications: NO_EMAIL_VERIFICATIONS,
      pendingRegistrations: NO_PENDING_REGISTRATIONS,
    }),
    issuer,
    { sign: async () => ACCESS_TOKEN, verify: async () => ({ sub: USER_ID }) },
    { hash: digestOf },
    { now: () => clockReading },
    GRACE_WINDOW_MS,
  )
}

const store = (props: {
  revokedAt?: Date
  replacedBy?: string
  expiresAt?: Date
  familyId?: string
}) =>
  repository.tokens.push(
    RefreshToken.fromTrusted({
      id: CURRENT_ID,
      userId: USER_ID,
      tokenHash: digestOf(CURRENT_TOKEN),
      familyId: props.familyId ?? FAMILY_ID,
      expiresAt: props.expiresAt ?? at(TTL_MS),
      revokedAt: props.revokedAt ?? null,
      replacedBy: props.replacedBy ?? null,
      createdAt: NOW,
    }),
  )

const storeSuccessor = () =>
  repository.tokens.push(
    RefreshToken.fromTrusted({
      id: SUCCESSOR_ID,
      userId: USER_ID,
      tokenHash: digestOf('successor-token'),
      familyId: FAMILY_ID,
      expiresAt: at(TTL_MS),
      revokedAt: null,
      replacedBy: null,
      createdAt: NOW,
    }),
  )

const refresh = () => useCase.execute({ refreshToken: CURRENT_TOKEN })

beforeEach(() => {
  clockReading = NOW
  build()
})

describe('RefreshTokenUseCase — rotation', () => {
  it('issues a new pair and revokes the presented token', async () => {
    store({})

    const result = await refresh()

    expect(result.accessToken).toBe(ACCESS_TOKEN)
    expect(result.refreshToken).not.toBe(CURRENT_TOKEN)

    const [current, successor] = repository.tokens
    expect(current?.revokedAt).toEqual(NOW)
    expect(current?.replacedBy).toBe(successor?.id)
  })

  it('keeps the successor in the SAME family', async () => {
    // The family is the chain. A new family per rotation would leave reuse
    // detection able to revoke nothing but the single stolen token.
    store({})

    await refresh()

    expect(repository.tokens[1]?.familyId).toBe(FAMILY_ID)
  })

  it('persists the digest of the new token, never the token itself', async () => {
    store({})

    const result = await refresh()

    expect(repository.tokens[1]?.tokenHash).toBe(digestOf(result.refreshToken))
  })
})

describe('RefreshTokenUseCase — refusals', () => {
  it('refuses a token it has never seen, revoking nothing', async () => {
    store({})

    await expect(useCase.execute({ refreshToken: UNKNOWN_TOKEN })).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    )

    expect(repository.tokens[0]?.revokedAt).toBeNull()
  })

  it('refuses an expired token WITHOUT revoking the family', async () => {
    // Expiry is not an attack: it is a client that was offline too long.
    // Killing the family here would log a user out for having a slow week.
    store({ expiresAt: at(-ONE_MILLISECOND) })

    await expect(refresh()).rejects.toBeInstanceOf(InvalidRefreshTokenError)
    expect(repository.tokens[0]?.revokedAt).toBeNull()
  })
})

describe('RefreshTokenUseCase — grace window', () => {
  it('accepts a rotated token inside the window and issues another pair', async () => {
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    clockReading = at(GRACE_WINDOW_MS)

    const result = await refresh()

    expect(result.refreshToken).not.toBe(CURRENT_TOKEN)
    expect(repository.tokens[1]?.familyId).toBe(FAMILY_ID)
  })

  it('does NOT move revokedAt, so the window cannot slide', async () => {
    // Sliding would turn a client stuck in a retry loop into an eternal session
    // over a token that should already be dead.
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    clockReading = at(GRACE_WINDOW_MS)

    await refresh()

    expect(repository.tokens[0]?.revokedAt).toEqual(NOW)
    expect(repository.tokens[0]?.replacedBy).toBe(SUCCESSOR_ID)
  })

  it('detects reuse past the window and revokes the whole family', async () => {
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(GRACE_WINDOW_MS + ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    // The live successor dies too, and that is the point: the thief and the
    // victim both lose the session, and the victim logs in again.
    expect(repository.tokens[1]?.revokedAt).toEqual(clockReading)
  })

  it('kills the successor that was already issued', async () => {
    // What closes the fork. The successor dies WITHOUT a `replacedBy` of its
    // own, so presenting it later lands in reuse detection instead of being
    // forgiven a second time.
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(GRACE_WINDOW_MS)

    await refresh()

    const successor = repository.tokens.find((token) => token.id === SUCCESSOR_ID)
    expect(successor?.revokedAt).toEqual(clockReading)
    expect(successor?.replacedBy).toBeNull()
  })

  it('makes that killed successor trip reuse detection', async () => {
    // The other half, and the reason the kill is worth anything: whoever was
    // holding the successor — the victim, when the replay came from a thief —
    // now trips detection on their next refresh, and the whole family dies.
    // Before this, both chains lived side by side and nothing ever fired.
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(GRACE_WINDOW_MS)
    await refresh()

    await expect(
      useCase.execute({ refreshToken: 'successor-token' }),
    ).rejects.toBeInstanceOf(RefreshTokenReusedError)

    expect(repository.tokens.every((token) => token.revokedAt !== null)).toBe(true)
  })

  it('still forgives the lost response, because that successor reached nobody', async () => {
    // The case the window exists for is untouched: the successor killed here
    // is the one that died in the tunnel, so killing it costs nothing.
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(GRACE_WINDOW_MS)

    const result = await refresh()

    expect(result.accessToken).toBe(ACCESS_TOKEN)
    expect(result.refreshToken).not.toBe(CURRENT_TOKEN)
  })

  it('refuses a token revoked by LOGOUT even inside the window', async () => {
    // The guard of the whole slice. `replacedBy` is null after a logout, so
    // this must NOT be treated as a lost-response retry — otherwise logging out
    // and refreshing within 30 seconds would hand back a working session.
    store({ revokedAt: NOW })
    clockReading = at(ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)
  })

  it('lets the grace window WIN over expiry', async () => {
    // The normative order. A client that rotates one second before expiry and
    // loses the response arrives with a token that is revoked AND expired;
    // checking expiry first would answer 401 and log it out — the exact random
    // logout the grace window exists to remove.
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID, expiresAt: at(ONE_MILLISECOND) })
    clockReading = at(GRACE_WINDOW_MS)

    const result = await refresh()

    expect(result.refreshToken).not.toBe(CURRENT_TOKEN)
  })

  it('treats a rotated token that resurfaces after expiry as reuse', async () => {
    // The other side of the same order: whoever legitimately rotated this token
    // holds its successor and has no reason to present the ancestor again.
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID, expiresAt: at(ONE_MILLISECOND) })
    clockReading = at(GRACE_WINDOW_MS + ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)
  })

  it('revokes only the presented family', async () => {
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    repository.tokens.push(
      RefreshToken.create({
        id: OTHER_FAMILY_TOKEN_ID,
        userId: USER_ID,
        tokenHash: digestOf('other-token'),
        familyId: OTHER_FAMILY_ID,
        now: NOW,
        ttlSeconds: TTL_SECONDS,
      }),
    )
    clockReading = at(GRACE_WINDOW_MS + ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    // Losing a stolen phone must not sign the tablet out.
    expect(repository.tokens[1]?.revokedAt).toBeNull()
  })

  it('COMMITS the family revocation instead of rolling it back', async () => {
    // The defect this test exists to prevent, and it is invisible to the
    // passthrough fake above: revoking the family and then THROWING from
    // inside the callback rolls the transaction back and undoes the very
    // revocation detection just performed. Reuse would fire, answer 401, and
    // leave the stolen family alive for the rest of its sixty days.
    //
    // So this one double models rollback, which slice 4 deliberately kept out
    // of the shared fake. Everything else in this file still uses the fake.
    const rollingBack: IAuthUnitOfWork = async (work) => {
      const snapshot = [...repository.tokens]

      try {
        return await work({
          users: NO_USERS,
          refreshTokens: repository,
          emailVerifications: NO_EMAIL_VERIFICATIONS,
          pendingRegistrations: NO_PENDING_REGISTRATIONS,
        })
      } catch (error) {
        repository.tokens.length = 0
        repository.tokens.push(...snapshot)
        throw error
      }
    }

    useCase = new RefreshTokenUseCase(
      rollingBack,
      new RefreshTokenIssuer(
        { opaque: () => 'opaque-rollback', numericCode: () => NUMERIC_CODE },
        { hash: digestOf },
        { generate: () => 'id-rollback' },
        TTL_SECONDS,
      ),
      { sign: async () => ACCESS_TOKEN, verify: async () => ({ sub: USER_ID }) },
      { hash: digestOf },
      { now: () => clockReading },
      GRACE_WINDOW_MS,
    )

    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(GRACE_WINDOW_MS + ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    // The successor must be dead. If the revocation was rolled back it is
    // still alive, and the stolen session survived its own detection.
    expect(repository.tokens[1]?.revokedAt).toEqual(clockReading)
  })

  it('writes nothing at all when the token is unknown', async () => {
    await expect(useCase.execute({ refreshToken: UNKNOWN_TOKEN })).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    )

    expect(repository.tokens).toHaveLength(NO_TOKENS)
  })
})

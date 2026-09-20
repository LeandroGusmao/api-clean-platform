import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { ListActiveSessionsUseCase } from '#modules/auth/use-cases/list-active-sessions'
import type { IClock } from '#shared/ports/clock'

/** Far enough that it never binds. */
const FAR_CEILING = new Date('2099-01-01T00:00:00.000Z')

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000000'
const FAMILY_A = '11112222-3333-4444-8555-666677778888'
const FAMILY_B = '99990000-1111-4222-8333-444455556666'
const TTL_SECONDS = 3600
const NOW = new Date('2026-09-16T12:00:00.000Z')
const LATER = new Date('2026-09-16T12:00:05.000Z')

const NO_SESSIONS = 0
const TWO_SESSIONS = 2
const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const SESSION_STARTED_AT = new Date('2026-08-01T09:00:00.000Z')

let sequence = 0
const nextId = () => {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

let refreshTokensRepository: InMemoryRefreshTokensRepository
let clock: IClock
let useCase: ListActiveSessionsUseCase

const activeToken = (familyId: string, userId: string = USER_ID) =>
  RefreshToken.create({
    id: nextId(),
    userId,
    tokenHash: nextId(),
    familyId,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
    lifetimeCeiling: FAR_CEILING,
    ip: IP,
    deviceLabel: DEVICE_LABEL,
    sessionStartedAt: SESSION_STARTED_AT,
  })

beforeEach(() => {
  refreshTokensRepository = new InMemoryRefreshTokensRepository()
  clock = { now: () => NOW }
  useCase = new ListActiveSessionsUseCase(refreshTokensRepository, clock)
})

describe('ListActiveSessionsUseCase', () => {
  it('returns one session per active family', async () => {
    await refreshTokensRepository.save(activeToken(FAMILY_A))
    await refreshTokensRepository.save(activeToken(FAMILY_B))

    const sessions = await useCase.execute(USER_ID)

    expect(sessions).toHaveLength(TWO_SESSIONS)
    expect(sessions.map((each) => each.id).sort()).toEqual([FAMILY_A, FAMILY_B].sort())
  })

  it('returns a flat result with the family id, not the entity', async () => {
    await refreshTokensRepository.save(activeToken(FAMILY_A))

    const [session] = await useCase.execute(USER_ID)

    expect(session).toEqual({
      id: FAMILY_A,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * 1000),
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      startedAt: SESSION_STARTED_AT,
    })
  })

  it('falls back to createdAt for a session older than the columns', async () => {
    await refreshTokensRepository.save(
      RefreshToken.create({
        id: nextId(),
        userId: USER_ID,
        tokenHash: nextId(),
        familyId: FAMILY_A,
        now: NOW,
        ttlSeconds: TTL_SECONDS,
        lifetimeCeiling: FAR_CEILING,
        ip: null,
        deviceLabel: null,
        sessionStartedAt: null,
      }),
    )

    const [session] = await useCase.execute(USER_ID)

    expect(session?.ip).toBeNull()
    expect(session?.deviceLabel).toBeNull()
    // Never null on the wire, so no client has to render "no start".
    expect(session?.startedAt).toEqual(NOW)
  })

  it('excludes a revoked session', async () => {
    const revoked = activeToken(FAMILY_A)
    await refreshTokensRepository.save(revoked)
    await refreshTokensRepository.revoke(revoked.id, LATER)

    const sessions = await useCase.execute(USER_ID)

    expect(sessions).toHaveLength(NO_SESSIONS)
  })

  it("excludes another user's sessions", async () => {
    await refreshTokensRepository.save(activeToken(FAMILY_A, OTHER_USER_ID))

    const sessions = await useCase.execute(USER_ID)

    expect(sessions).toHaveLength(NO_SESSIONS)
  })

  it('returns an empty array for a user with no active session', async () => {
    const sessions = await useCase.execute(USER_ID)

    expect(sessions).toEqual([])
  })
})

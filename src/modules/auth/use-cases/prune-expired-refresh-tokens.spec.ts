import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import {
  PRUNE_EXPIRED_REFRESH_TOKENS_JOB,
  PruneExpiredRefreshTokensUseCase,
} from '#modules/auth/use-cases/prune-expired-refresh-tokens'

const NOW = new Date('2026-09-07T12:00:00.000Z')
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const PRUNED_TWO = 2
const KEPT_ONE = 1
const NONE = 0

const at = (id: string, expiresAt: Date) =>
  RefreshToken.fromTrusted({
    id,
    userId: USER_ID,
    tokenHash: `digest:${id}`,
    familyId: FAMILY_ID,
    expiresAt,
    revokedAt: null,
    replacedBy: null,
    createdAt: expiresAt,
  })

let repository: InMemoryRefreshTokensRepository
let useCase: PruneExpiredRefreshTokensUseCase

beforeEach(() => {
  repository = new InMemoryRefreshTokensRepository()
  useCase = new PruneExpiredRefreshTokensUseCase(
    repository,
    { now: () => NOW },
    RETENTION_MS,
  )
})

describe('PruneExpiredRefreshTokensUseCase', () => {
  it('names its job', () => {
    expect(PRUNE_EXPIRED_REFRESH_TOKENS_JOB).toBe('prune-expired-refresh-tokens')
  })

  it('deletes tokens whose expiry is at or before now minus the retention window', async () => {
    const cutoff = NOW.getTime() - RETENTION_MS
    repository.tokens.push(
      at('dead', new Date(cutoff - ONE_MINUTE_MS)),
      at('exactly-on-cutoff', new Date(cutoff)),
      at('inside-window', new Date(cutoff + ONE_MINUTE_MS)),
    )

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: PRUNED_TWO })
    expect(repository.tokens.map((token) => token.id)).toEqual(['inside-window'])
    expect(repository.tokens).toHaveLength(KEPT_ONE)
  })

  it('reports zero when nothing is old enough', async () => {
    repository.tokens.push(at('fresh', new Date(NOW.getTime() + ONE_MINUTE_MS)))

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: NONE })
    expect(repository.tokens).toHaveLength(KEPT_ONE)
  })
})

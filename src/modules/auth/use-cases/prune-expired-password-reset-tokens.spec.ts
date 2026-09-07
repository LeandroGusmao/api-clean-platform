import { beforeEach, describe, expect, it } from 'vitest'
import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import { InMemoryPasswordResetTokensRepository } from '#modules/auth/infra/in-memory/in-memory-password-reset-tokens-repository'
import {
  PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB,
  PruneExpiredPasswordResetTokensUseCase,
} from '#modules/auth/use-cases/prune-expired-password-reset-tokens'

const NOW = new Date('2026-09-07T12:00:00.000Z')
const RETENTION_MS = 24 * 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const PRUNED_TWO = 2
const KEPT_ONE = 1
const NONE = 0

const at = (id: string, expiresAt: Date) =>
  PasswordResetToken.fromTrusted({
    id,
    userId: USER_ID,
    tokenHash: `digest:${id}`,
    issuedAt: expiresAt,
    expiresAt,
    consumedAt: null,
    createdAt: expiresAt,
  })

let repository: InMemoryPasswordResetTokensRepository
let useCase: PruneExpiredPasswordResetTokensUseCase

beforeEach(() => {
  repository = new InMemoryPasswordResetTokensRepository()
  useCase = new PruneExpiredPasswordResetTokensUseCase(
    repository,
    { now: () => NOW },
    RETENTION_MS,
  )
})

describe('PruneExpiredPasswordResetTokensUseCase', () => {
  it('names its job', () => {
    expect(PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB).toBe(
      'prune-expired-password-reset-tokens',
    )
  })

  it('deletes tokens whose expiry is at or before now minus the retention window', async () => {
    const cutoff = NOW.getTime() - RETENTION_MS
    repository.rows.push(
      at('dead', new Date(cutoff - ONE_MINUTE_MS)),
      at('exactly-on-cutoff', new Date(cutoff)),
      at('inside-window', new Date(cutoff + ONE_MINUTE_MS)),
    )

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: PRUNED_TWO })
    expect(repository.rows.map((row) => row.id)).toEqual(['inside-window'])
    expect(repository.rows).toHaveLength(KEPT_ONE)
  })

  it('reports zero when nothing is old enough', async () => {
    repository.rows.push(at('fresh', new Date(NOW.getTime() + ONE_MINUTE_MS)))

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: NONE })
    expect(repository.rows).toHaveLength(KEPT_ONE)
  })
})

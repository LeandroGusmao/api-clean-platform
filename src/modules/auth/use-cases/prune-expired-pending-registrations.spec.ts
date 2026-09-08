import { beforeEach, describe, expect, it } from 'vitest'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { InMemoryPendingRegistrationsRepository } from '#modules/auth/infra/in-memory/in-memory-pending-registrations-repository'
import {
  PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB,
  PruneExpiredPendingRegistrationsUseCase,
} from '#modules/auth/use-cases/prune-expired-pending-registrations'
import { Email } from '#modules/auth/value-objects/email'

const NOW = new Date('2026-09-07T12:00:00.000Z')
const RETENTION_MS = 24 * 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000
const EMAIL = 'joao@example.com'
const NO_ATTEMPTS = 0
const PRUNED_TWO = 2
const KEPT_ONE = 1
const NONE = 0

const at = (id: string, expiresAt: Date) =>
  PendingRegistration.fromTrusted({
    id,
    email: Email.create(EMAIL),
    codeHash: `digest:${id}`,
    attempts: NO_ATTEMPTS,
    codeIssuedAt: expiresAt,
    expiresAt,
    consumedAt: null,
    createdAt: expiresAt,
  })

let repository: InMemoryPendingRegistrationsRepository
let useCase: PruneExpiredPendingRegistrationsUseCase

beforeEach(() => {
  repository = new InMemoryPendingRegistrationsRepository()
  useCase = new PruneExpiredPendingRegistrationsUseCase(
    repository,
    { now: () => NOW },
    RETENTION_MS,
  )
})

describe('PruneExpiredPendingRegistrationsUseCase', () => {
  it('names its job', () => {
    expect(PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB).toBe(
      'prune-expired-pending-registrations',
    )
  })

  it('deletes rows whose expiry is at or before now minus the retention window', async () => {
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

import { describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const OTHER_FAMILY_ID = '99990000-1111-4222-8333-444455556666'
const NOW = new Date('2026-08-31T12:00:00.000Z')
const LATER = new Date('2026-08-31T12:00:05.000Z')
const EXPIRES_AT = new Date('2026-09-30T12:00:00.000Z')
const NO_TOKENS = 0
const TWO_TOKENS = 2

const token = (id: string, familyId: string, revokedAt: Date | null) =>
  RefreshToken.fromTrusted({
    id,
    userId: USER_ID,
    tokenHash: `digest:${id}`,
    familyId,
    expiresAt: EXPIRES_AT,
    revokedAt,
    replacedBy: null,
    createdAt: NOW,
    ip: null,
    deviceLabel: null,
    sessionStartedAt: null,
  })

describe('InMemoryRefreshTokensRepository.revokeFamily', () => {
  it('returns how many tokens it revoked, leaving another family alone', async () => {
    const repository = new InMemoryRefreshTokensRepository()
    repository.tokens.push(
      token('a', FAMILY_ID, null),
      token('b', FAMILY_ID, null),
      token('c', OTHER_FAMILY_ID, null),
    )

    const revoked = await repository.revokeFamily(FAMILY_ID, LATER)

    expect(revoked).toBe(TWO_TOKENS)
    expect(repository.tokens[2]?.revokedAt).toBeNull()
  })

  it('returns zero once the family is already revoked', async () => {
    const repository = new InMemoryRefreshTokensRepository()
    repository.tokens.push(token('a', FAMILY_ID, NOW))

    expect(await repository.revokeFamily(FAMILY_ID, LATER)).toBe(NO_TOKENS)
    expect(repository.tokens[0]?.revokedAt).toEqual(NOW)
  })

  it('returns zero for a family that does not exist', async () => {
    const repository = new InMemoryRefreshTokensRepository()

    expect(await repository.revokeFamily(FAMILY_ID, LATER)).toBe(NO_TOKENS)
  })
})

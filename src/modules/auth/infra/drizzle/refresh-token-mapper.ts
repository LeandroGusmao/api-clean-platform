import { RefreshToken } from '#modules/auth/entities/refresh-token'
import type { refreshTokens } from './schema/refresh-tokens.js'

type NewRefreshTokenRow = typeof refreshTokens.$inferInsert
type RefreshTokenRow = typeof refreshTokens.$inferSelect

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like.
 */
export const toPersistenceRefreshToken = (token: RefreshToken): NewRefreshTokenRow => ({
  id: token.id,
  userId: token.userId,
  tokenHash: token.tokenHash,
  familyId: token.familyId,
  expiresAt: token.expiresAt,
  revokedAt: token.revokedAt,
  replacedBy: token.replacedBy,
  createdAt: token.createdAt,
  ip: token.ip,
  deviceLabel: token.deviceLabel,
  sessionStartedAt: token.sessionStartedAt,
})

/** Row to entity. Rehydrates rather than validates — see `RefreshToken.fromTrusted`. */
export const toDomainRefreshToken = (row: RefreshTokenRow): RefreshToken =>
  RefreshToken.fromTrusted({
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    replacedBy: row.replacedBy,
    createdAt: row.createdAt,
    ip: row.ip,
    deviceLabel: row.deviceLabel,
    sessionStartedAt: row.sessionStartedAt,
  })

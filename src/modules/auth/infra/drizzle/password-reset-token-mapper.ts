import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import type { passwordResetTokens } from './schema/password-reset-tokens.js'

type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect

/**
 * Row to entity. Rehydrates rather than validates — see
 * `PasswordResetToken.fromTrusted`. There is no entity-to-row direction:
 * `issueOrRefresh` writes columns directly because the ON CONFLICT path has no
 * entity to map.
 */
export const toDomainPasswordResetToken = (
  row: PasswordResetTokenRow,
): PasswordResetToken =>
  PasswordResetToken.fromTrusted({
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  })

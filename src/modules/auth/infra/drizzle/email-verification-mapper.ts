import { EmailVerification } from '#modules/auth/entities/email-verification'
import type { emailVerificationTokens } from './schema/email-verification-tokens.js'

type NewEmailVerificationRow = typeof emailVerificationTokens.$inferInsert
type EmailVerificationRow = typeof emailVerificationTokens.$inferSelect

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like (decision 20).
 */
export const toPersistenceEmailVerification = (
  verification: EmailVerification,
): NewEmailVerificationRow => ({
  id: verification.id,
  userId: verification.userId,
  codeHash: verification.codeHash,
  expiresAt: verification.expiresAt,
  consumedAt: verification.consumedAt,
  attempts: verification.attempts,
  createdAt: verification.createdAt,
})

/** Row to entity. Rehydrates rather than validates — see `EmailVerification.fromTrusted`. */
export const toDomainEmailVerification = (row: EmailVerificationRow): EmailVerification =>
  EmailVerification.fromTrusted({
    id: row.id,
    userId: row.userId,
    codeHash: row.codeHash,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    attempts: row.attempts,
    createdAt: row.createdAt,
  })

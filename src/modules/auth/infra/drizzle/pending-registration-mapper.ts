import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { Email } from '#modules/auth/value-objects/email'
import type { pendingRegistrations } from './schema/pending-registrations.js'

type NewPendingRegistrationRow = typeof pendingRegistrations.$inferInsert
type PendingRegistrationRow = typeof pendingRegistrations.$inferSelect

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like.
 */
export const toPersistencePendingRegistration = (
  pending: PendingRegistration,
): NewPendingRegistrationRow => ({
  id: pending.id,
  // Unwrapping the value object is infra's job, not the domain's.
  email: pending.email.value,
  codeHash: pending.codeHash,
  attempts: pending.attempts,
  codeIssuedAt: pending.codeIssuedAt,
  expiresAt: pending.expiresAt,
  consumedAt: pending.consumedAt,
  createdAt: pending.createdAt,
})

/**
 * Row to entity. Rehydrates rather than validates — see
 * `PendingRegistration.fromTrusted`.
 */
export const toDomainPendingRegistration = (
  row: PendingRegistrationRow,
): PendingRegistration =>
  PendingRegistration.fromTrusted({
    id: row.id,
    // Wrapping the primitive is infra's job, not the domain's.
    email: Email.fromTrusted(row.email),
    codeHash: row.codeHash,
    attempts: row.attempts,
    codeIssuedAt: row.codeIssuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  })

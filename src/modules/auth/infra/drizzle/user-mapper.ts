import type { User } from '#modules/auth/entities/user'
import type { users } from './schema/users.js'

type NewUserRow = typeof users.$inferInsert

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like (decision 20).
 *
 * One direction only, on purpose: nothing reads a user yet, so `toDomainUser`
 * would have no consumer. It arrives with login, exercised by `findByEmail`.
 */
export const toPersistenceUser = (user: User): NewUserRow => ({
  id: user.id,
  // Unwrapping the value object is infra's job, not the domain's.
  email: user.email.value,
  passwordHash: user.passwordHash,
  emailVerifiedAt: user.emailVerifiedAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
})

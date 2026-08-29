import { User } from '#modules/auth/entities/user'
import { Email } from '#modules/auth/value-objects/email'
import type { users } from './schema/users.js'

type NewUserRow = typeof users.$inferInsert
type UserRow = typeof users.$inferSelect

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like (decision 20).
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

/**
 * Row to entity. Both directions rehydrate rather than validate — see
 * `User.fromTrusted`.
 */
export const toDomainUser = (row: UserRow): User =>
  User.fromTrusted({
    id: row.id,
    // Wrapping the primitive is infra's job, not the domain's.
    email: Email.fromTrusted(row.email),
    passwordHash: row.passwordHash,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })

import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * One live single-use token proving control of an email address for an account
 * that ALREADY exists. 256 bits of opaque entropy, digested with sha256; the
 * plaintext lives only in the email being sent.
 *
 * NO column defaults, like `refresh-tokens.ts`: Postgres stores `timestamptz`
 * in microseconds and a JS `Date` in milliseconds, and `isUsable` compares
 * instants — so every timestamp comes from `IClock`.
 *
 * `unique(user_id)` — one live token per account. It is the arbiter of the
 * `INSERT ... ON CONFLICT (user_id)` the `forgot` use case runs, so a fresh
 * `forgot` supersedes the previous token in place. `issued_at` moves on every
 * supersede; `created_at` is immutable, for prune order and audit. `consumed_at`
 * marks a redeemed reset.
 */

/**
 * Exported because the repository reads it: a `23505` carrying THIS constraint
 * is not a database error, it is a security alarm — 32 bytes of `randomBytes`
 * do not collide, so what produces it in practice is a token generator that
 * regressed to something predictable. The primary key raises `23505` too, and
 * that one keeps bubbling as an ordinary persistence failure. Same reasoning as
 * `REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX`; once a name is read from another
 * file it stops appearing once and becomes a constant.
 */
export const PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX =
  'password_reset_tokens_token_hash_unique'

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the opaque token. Never the token itself. */
    tokenHash: text('token_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // One live token per account — the ON CONFLICT target of `forgot`. Spelled
    // inline: the name appears exactly once.
    uniqueIndex('password_reset_tokens_user_id_unique').on(table.userId),
    // The `reset` lookup path. Named via the constant above because the
    // repository matches a 23505 against it.
    uniqueIndex(PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX).on(table.tokenHash),
  ],
)

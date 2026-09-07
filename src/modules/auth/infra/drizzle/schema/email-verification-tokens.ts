import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * A single-use, six-digit code proving control of an email address. This module
 * owns the table, and the foreign key to `users` is legal because both live
 * inside `auth` (decision 24).
 *
 * NO column defaults, exactly as in `refresh-tokens.ts` and for the same reason:
 * Postgres stores `timestamptz` in microseconds while a JS `Date` has
 * milliseconds, and the TTL compares instants — so every timestamp here comes
 * from `IClock` and both sides of every comparison share a source. `attempts` is
 * written explicitly too: the entity owns the value, and a default would be
 * defence in depth for a direct write that has no legitimate caller.
 *
 * `consumed_at` marks BOTH "burned by a successful confirm" and "superseded by a
 * reissue". `refresh_tokens` separates those into `revoked_at` + `replaced_by`
 * because reuse detection needs the distinction; here there is no chain, and
 * nothing downstream reads the difference.
 *
 * **No unique index on `code_hash`, and that is the difference from
 * `refresh_tokens` that matters.** Six digits collide by design — 10^6 values
 * for the whole base — so two accounts holding the same pending code is an
 * ordinary event, not an alarm, and a unique index would refuse the second
 * legitimate issue. Lookup is therefore ALWAYS by `user_id`: a global lookup by
 * `code_hash` would let one user's code confirm another user's account.
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the code. Never the code itself. */
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Wrong guesses so far. The use case caps it; that cap is what makes six digits safe. */
    attempts: integer('attempts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The FK's cascade needs it: without it every user deletion scans this table.
    index('email_verification_tokens_user_id_idx').on(table.userId),
    // The hot path — `findActiveByUserId` and `invalidateActiveForUser`. Expiry
    // is filtered at query time and NOT in this predicate: a partial index
    // predicate must be IMMUTABLE, and `now()` is not.
    index('email_verification_tokens_active_idx')
      .on(table.userId)
      .where(sql`${table.consumedAt} is null`),
  ],
)

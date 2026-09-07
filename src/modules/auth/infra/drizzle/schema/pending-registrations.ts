import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * A single-use, six-digit code proving control of an email address, minted
 * before any `users` row exists. The account is created when a code here is
 * redeemed together with a chosen password (§1 of the slice 11 design), so this
 * table carries NO password: whoever completes confirmation picks it.
 *
 * NO column defaults, exactly as in `refresh-tokens.ts`: Postgres stores
 * `timestamptz` in microseconds while a JS `Date` has milliseconds, and
 * `isUsable` compares instants — so every timestamp comes from `IClock` and both
 * sides of every comparison share a source. `attempts` is written explicitly for
 * the same reason: the entity owns the value.
 *
 * NO foreign key: there is no user row to point at yet. NO unique index on
 * `email`: several pending registrations for one address coexist by design, and
 * that fungibility is what closes the pre-hijacking in both orderings. NO unique
 * index on `code_hash`: six digits collide by design, and every lookup is by
 * `lower(email)`.
 *
 * `code_issued_at` moves on every reissue (§4.2); `created_at` is immutable and
 * only for pruning order and audit. `consumed_at` marks BOTH "redeemed by a
 * confirm" and "superseded by a reissue"; nothing downstream reads the
 * difference.
 */
export const pendingRegistrations = pgTable(
  'pending_registrations',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    /** sha256 of the six-digit code. Never the code itself. */
    codeHash: text('code_hash').notNull(),
    /** Wrong guesses so far. The use case caps it; that cap is what makes six digits safe. */
    attempts: integer('attempts').notNull(),
    codeIssuedAt: timestamp('code_issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The prune path — `deleteExpiredByEmail` — needs consumed rows too, so it
    // cannot use the partial index below. Expiry is filtered at query time and
    // NOT in a predicate here: a partial index predicate must be IMMUTABLE, and
    // `now()` is not.
    index('pending_registrations_email_lower_idx').on(sql`lower(${table.email})`),
    // The hot lookups — `findUnconsumedByEmail`, the register cooldown, the
    // resend target.
    index('pending_registrations_active_idx')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.consumedAt} is null`),
  ],
)

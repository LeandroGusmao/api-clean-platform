import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * One link in a rotating refresh chain. This module owns the
 * table, and the foreign key to `users` is legal because both live inside
 * `auth`.
 *
 * NO column defaults, unlike `users`. Postgres stores `timestamptz` in
 * microseconds while a JS `Date` has milliseconds, and the grace window
 * compares instants — so every timestamp here comes from `IClock`, and both
 * sides of every comparison share a source. `users` can afford defaults
 * because they are defence in depth for direct writes; a refresh token has no
 * legitimate direct write to defend.
 *
 * `replaced_by` carries NO foreign key on purpose. It is what separates
 * "revoked by rotation" from "revoked by logout" — diagnosis and state, not
 * referential integrity — and a self-reference would force the future pruning
 * job to delete a chain in order.
 */

/**
 * Exported because the repository reads it: a `23505` carrying THIS constraint
 * is not a database error, it is a security alarm — 32 bytes of `randomBytes`
 * do not collide, so what produces it in practice is a token generator that
 * regressed to something low-entropy, meaning issued tokens are predictable.
 *
 * The primary key raises `23505` too, and that one keeps bubbling as an
 * ordinary persistence failure: a repeated id means a broken `IIdGenerator`,
 * which is annoying rather than dangerous.
 *
 * The `CLAUDE.md` exception that lets schema files spell names inline justifies
 * itself by the name appearing exactly once. This one no longer does.
 */
export const REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX = 'refresh_tokens_token_hash_unique'

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the opaque token. Never the token itself. */
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    /**
     * The request that created THIS row, so a rotation records where the client
     * is now. Nullable because the address may not parse — `parsedClientIp`
     * refuses to store attacker-chosen text, and null is what it returns.
     */
    ip: text('ip'),
    /**
     * Derived from the User-Agent when the family opened, and inherited by
     * every rotation — it names the DEVICE, which does not change mid session.
     * The raw header is deliberately not stored. Never null: a User-Agent that
     * names nothing recognisable still yields `UNKNOWN_DEVICE_LABEL`.
     */
    deviceLabel: text('device_label').notNull(),
    /**
     * When the family opened. Carried across rotations because rotation
     * discards the row that knew it.
     */
    sessionStartedAt: timestamp('session_started_at', {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex(REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX).on(table.tokenHash),
    // The WHERE of `revokeFamily` and `revokeAllForUser`. Without them each
    // revocation scans the table, on the hottest write path in the module.
    // Spelled inline because each appears exactly once — the constant above is
    // the one the repository reads back.
    index('refresh_tokens_family_id_idx').on(table.familyId),
    index('refresh_tokens_user_id_idx').on(table.userId),
  ],
)

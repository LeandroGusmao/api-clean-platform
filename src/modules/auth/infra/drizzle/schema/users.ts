import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Credentials of an application user. This module owns the table: a foreign key
 * may point here only from inside `auth`. Other modules reference a user by id,
 * with no database constraint, so that a module stays extractable.
 *
 * Every default below is defense-in-depth for direct writes (seeds, psql). The
 * application is the source of truth: from the next slice on, `IIdGenerator` and
 * `IClock` produce `id`, `created_at` and `updated_at`, and the repository sends
 * them explicitly.
 *
 * The domain normalizes email to lowercase; the functional unique index enforces
 * case-insensitive uniqueness without requiring the `citext` extension.
 */

/**
 * Exported because the repository reads it: it translates a `23505` carrying
 * THIS constraint into `EmailAlreadyInUseError`, and lets every other unique
 * violation bubble — the table's primary key raises `23505` too.
 *
 * The CLAUDE.md exception that lets schema files spell names inline justifies
 * itself by the name appearing exactly once. It no longer does.
 */
export const USERS_EMAIL_LOWER_UNIQUE_INDEX = 'users_email_lower_unique'

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /**
     * Null for federated-identity accounts (slice 14), which have no password.
     * Every other account is born with a hash at confirmation.
     */
    passwordHash: text('password_hash'),
    /**
     * Null until the account is verified. A reserved seat: nothing reads it
     * until the email verification slice, and it is here now so that neither
     * the `User` entity nor `user-mapper.ts` changes when that lands.
     */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex(USERS_EMAIL_LOWER_UNIQUE_INDEX).on(sql`lower(${table.email})`)],
)

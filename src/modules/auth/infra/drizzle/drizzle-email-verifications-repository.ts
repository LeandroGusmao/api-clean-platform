import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type { EmailVerification } from '#modules/auth/entities/email-verification'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
import {
  toDomainEmailVerification,
  toPersistenceEmailVerification,
} from './email-verification-mapper.js'
import { emailVerificationTokens } from './schema/email-verification-tokens.js'

/** `findActiveByUserId` returns at most one row: the most recent. */
const SINGLE_ROW = 1

/** How many rows a conditional `UPDATE` affected when nothing matched its `WHERE`. */
const NO_ROW_AFFECTED = 0

const ONE_INCREMENT = 1

export class DrizzleEmailVerificationsRepository
  implements IEmailVerificationsRepository
{
  constructor(private readonly db: Database) {}

  async save(verification: EmailVerification): Promise<void> {
    try {
      await this.db
        .insert(emailVerificationTokens)
        .values(toPersistenceEmailVerification(verification))
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this insert binds the
      // digest of the code.
      throw toPersistenceError(error)
    }
  }

  async findActiveByUserId(userId: string): Promise<EmailVerification | null> {
    // Ordered by `createdAt DESC`: after a resend, two unconsumed rows can
    // exist for a moment, and the most recent is the one that must win the
    // lookup — otherwise the stale code would answer and the fresh one issued
    // to the user would never work.
    const [row] = await this.db
      .select()
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          isNull(emailVerificationTokens.consumedAt),
        ),
      )
      .orderBy(desc(emailVerificationTokens.createdAt))
      .limit(SINGLE_ROW)

    return row === undefined ? null : toDomainEmailVerification(row)
  }

  async invalidateActiveForUser(userId: string, at: Date): Promise<void> {
    await this.db
      .update(emailVerificationTokens)
      .set({ consumedAt: at })
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          isNull(emailVerificationTokens.consumedAt),
        ),
      )
  }

  async registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean> {
    // The conditional `UPDATE`, not a read-then-write: a read-modify-write
    // would let every one of N concurrent guesses read the same `attempts`
    // value, all pass a comparison made against that read, and all write —
    // which is exactly the bypass this method exists to close. Folding the
    // read into the `WHERE` clause and letting Postgres's row lock serialize
    // the writes is what makes the cap hold under concurrency, the same way
    // `consume`'s conditional `UPDATE` makes single use hold.
    const result = await this.db
      .update(emailVerificationTokens)
      .set({
        attempts: sql`${emailVerificationTokens.attempts} + ${ONE_INCREMENT}`,
      })
      .where(
        and(
          eq(emailVerificationTokens.id, id),
          isNull(emailVerificationTokens.consumedAt),
          lt(emailVerificationTokens.attempts, maxAttempts),
        ),
      )

    // Same reasoning as `consume`'s `rowCount` handling below: fail closed if
    // the driver ever surfaces `null` instead of a count.
    return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.db
      .update(emailVerificationTokens)
      .set({ consumedAt: at })
      .where(
        and(
          eq(emailVerificationTokens.id, id),
          isNull(emailVerificationTokens.consumedAt),
        ),
      )

    // Measured against `drizzle-orm@1.0.0-rc.4` over `node-postgres`: an
    // awaited `update()` resolves to the driver's raw `pg.QueryResult`, whose
    // `rowCount` was `1` for a matched row and `0` for a miss — never `null`
    // in either case observed here. Its TS type is still `number | null` (the
    // pg client's own signature), so `null` is treated as "matched nothing"
    // rather than trusted as truthy: the single-use guarantee must fail closed,
    // not open, if the driver ever surfaces `null` in some other path.
    return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
  }
}

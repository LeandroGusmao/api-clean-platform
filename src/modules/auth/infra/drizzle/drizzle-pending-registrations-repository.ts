import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type { PendingRegistration } from '#modules/auth/entities/pending-registration'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { Email } from '#modules/auth/value-objects/email'
import {
  toDomainPendingRegistration,
  toPersistencePendingRegistration,
} from './pending-registration-mapper.js'
import { pendingRegistrations } from './schema/pending-registrations.js'

/** How many rows a conditional `UPDATE` affected when nothing matched its `WHERE`. */
const NO_ROW_AFFECTED = 0

/** Reset value for `attempts` on a reissue, and the increment step. */
const ATTEMPTS_RESET = 0
const ONE_INCREMENT = 1

export class DrizzlePendingRegistrationsRepository
  implements IPendingRegistrationsRepository
{
  constructor(private readonly db: Database) {}

  async save(pending: PendingRegistration): Promise<void> {
    try {
      await this.db
        .insert(pendingRegistrations)
        .values(toPersistencePendingRegistration(pending))
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this insert binds the digest.
      throw toPersistenceError(error)
    }
  }

  async findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]> {
    try {
      // `lower(email)` on the left aligns the expression with the functional
      // index, the same way `DrizzleUsersRepository.findByEmail` does. Ordered
      // `code_issued_at DESC` so the caller's `[0]` is the freshest live code.
      const rows = await this.db
        .select()
        .from(pendingRegistrations)
        .where(
          and(
            sql`lower(${pendingRegistrations.email}) = ${email.value}`,
            isNull(pendingRegistrations.consumedAt),
          ),
        )
        .orderBy(desc(pendingRegistrations.codeIssuedAt))

      return rows.map(toDomainPendingRegistration)
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this SELECT binds the address.
      throw toPersistenceError(error)
    }
  }

  async reissueCode(
    id: string,
    codeHash: string,
    codeIssuedAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    try {
      await this.db
        .update(pendingRegistrations)
        .set({ codeHash, attempts: ATTEMPTS_RESET, codeIssuedAt, expiresAt })
        .where(
          and(eq(pendingRegistrations.id, id), isNull(pendingRegistrations.consumedAt)),
        )
    } catch (error) {
      // Same reason as `save`: this statement binds the new digest.
      throw toPersistenceError(error)
    }
  }

  async registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean> {
    // The conditional `UPDATE`, not a read-then-write: N concurrent guesses
    // would all read the same `attempts`, all pass a comparison against it, and
    // all write. Folding the read into the `WHERE` and letting Postgres's row
    // lock serialize the writes is what holds the cap.
    const result = await this.db
      .update(pendingRegistrations)
      .set({
        attempts: sql`${pendingRegistrations.attempts} + ${ONE_INCREMENT}`,
      })
      .where(
        and(
          eq(pendingRegistrations.id, id),
          isNull(pendingRegistrations.consumedAt),
          sql`${pendingRegistrations.attempts} < ${maxAttempts}`,
        ),
      )

    return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.db
      .update(pendingRegistrations)
      .set({ consumedAt: at })
      .where(
        and(eq(pendingRegistrations.id, id), isNull(pendingRegistrations.consumedAt)),
      )

    // Its TS type is `number | null` (the pg client's own signature), so `null`
    // is treated as "matched nothing" rather than trusted as truthy: single use
    // must fail CLOSED, not open, if the driver ever surfaces `null`.
    return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
  }

  async deleteExpiredByEmail(email: Email, now: Date): Promise<void> {
    await this.db
      .delete(pendingRegistrations)
      .where(
        and(
          sql`lower(${pendingRegistrations.email}) = ${email.value}`,
          or(
            lte(pendingRegistrations.expiresAt, now),
            sql`${pendingRegistrations.consumedAt} is not null`,
          ),
        ),
      )
  }

  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(pendingRegistrations)
      .where(lte(pendingRegistrations.expiresAt, cutoff))

    return result.rowCount ?? NO_ROW_AFFECTED
  }
}

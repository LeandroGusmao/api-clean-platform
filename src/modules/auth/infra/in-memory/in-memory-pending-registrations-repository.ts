import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { Email } from '#modules/auth/value-objects/email'

const ONE_INCREMENT = 1
const ATTEMPTS_RESET = 0

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09).
 *
 * It models NO row lock and NO conditional-update race: a unit test runs one
 * call at a time. Atomicity of `consume` and `registerFailedAttempt` is proved
 * against real Postgres, in
 * `tests/integration/drizzle-pending-registrations-repository.spec.ts` —
 * treating this class as evidence would be exactly the mistake the conditional
 * `UPDATE` exists to prevent.
 */
export class InMemoryPendingRegistrationsRepository
  implements IPendingRegistrationsRepository
{
  readonly rows: PendingRegistration[] = []

  async save(pending: PendingRegistration): Promise<void> {
    this.rows.push(pending)
  }

  async findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]> {
    // The most recent code first, sorted the same way the Drizzle adapter's
    // `ORDER BY code_issued_at DESC` does.
    return this.rows
      .filter((each) => each.email.equals(email) && each.consumedAt === null)
      .sort((a, b) => b.codeIssuedAt.getTime() - a.codeIssuedAt.getTime())
  }

  async reissueCode(
    id: string,
    codeHash: string,
    codeIssuedAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    this.#replaceMatching((each) => each.id === id && each.consumedAt === null, {
      codeHash,
      attempts: ATTEMPTS_RESET,
      codeIssuedAt,
      expiresAt,
    })
  }

  async registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean> {
    // Mirrors the Drizzle adapter's conditional `UPDATE`: only a row still
    // unconsumed AND under the cap is incremented. One call at a time here, so
    // there is no race to reproduce — this exercises the same CONDITION.
    const current = this.rows.find(
      (each) => each.id === id && each.consumedAt === null && each.attempts < maxAttempts,
    )
    if (current === undefined) return false

    this.#replaceMatching((each) => each.id === id, {
      attempts: current.attempts + ONE_INCREMENT,
    })
    return true
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const current = this.rows.find((each) => each.id === id && each.consumedAt === null)
    if (current === undefined) return false

    this.#replaceMatching((each) => each.id === id, { consumedAt: at })
    return true
  }

  async deleteExpiredByEmail(email: Email, now: Date): Promise<void> {
    for (
      let index = this.rows.length - ONE_INCREMENT;
      index >= 0;
      index -= ONE_INCREMENT
    ) {
      const each = this.rows[index]
      if (each === undefined) continue

      const sameEmail = each.email.equals(email)
      const expired = each.expiresAt.getTime() <= now.getTime()
      const consumed = each.consumedAt !== null

      if (sameEmail && (expired || consumed)) {
        this.rows.splice(index, ONE_INCREMENT)
      }
    }
  }

  /** The entity is frozen, so "updating" means rebuilding it in place. */
  #replaceMatching(
    matches: (pending: PendingRegistration) => boolean,
    changes: {
      codeHash?: string
      attempts?: number
      codeIssuedAt?: Date
      expiresAt?: Date
      consumedAt?: Date
    },
  ): void {
    this.rows.forEach((pending, index) => {
      if (!matches(pending)) return

      this.rows[index] = PendingRegistration.fromTrusted({
        id: pending.id,
        email: pending.email,
        codeHash: changes.codeHash ?? pending.codeHash,
        attempts: changes.attempts ?? pending.attempts,
        codeIssuedAt: changes.codeIssuedAt ?? pending.codeIssuedAt,
        expiresAt: changes.expiresAt ?? pending.expiresAt,
        consumedAt: changes.consumedAt ?? pending.consumedAt,
        createdAt: pending.createdAt,
      })
    })
  }
}

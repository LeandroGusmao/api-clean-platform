import { EmailVerification } from '#modules/auth/entities/email-verification'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'

const ONE_INCREMENT = 1

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09).
 *
 * It models NO row lock and NO conditional-update race, because there is
 * nothing to race: a unit test runs one call at a time. The single-use
 * guarantee is proved against real Postgres, in
 * `tests/integration/drizzle-email-verifications-repository.spec.ts` —
 * treating this class as evidence that `consume` is race-proof would be
 * exactly the mistake the conditional `UPDATE` exists to prevent.
 */
export class InMemoryEmailVerificationsRepository
  implements IEmailVerificationsRepository
{
  readonly verifications: EmailVerification[] = []

  async save(verification: EmailVerification): Promise<void> {
    this.verifications.push(verification)
  }

  async findActiveByUserId(userId: string): Promise<EmailVerification | null> {
    // The most recent unconsumed row, sorted the same way the Drizzle adapter's
    // `ORDER BY created_at DESC LIMIT 1` does: after a resend, the stale code
    // must not win the lookup.
    const candidates = this.verifications
      .filter((each) => each.userId === userId && each.consumedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    return candidates[0] ?? null
  }

  async invalidateActiveForUser(userId: string, at: Date): Promise<void> {
    this.#replaceMatching((each) => each.userId === userId && each.consumedAt === null, {
      consumedAt: at,
    })
  }

  async incrementAttempts(id: string): Promise<void> {
    const current = this.verifications.find((each) => each.id === id)
    if (current === undefined) return

    this.#replaceMatching((each) => each.id === id, {
      attempts: current.attempts + ONE_INCREMENT,
    })
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const current = this.verifications.find(
      (each) => each.id === id && each.consumedAt === null,
    )
    if (current === undefined) return false

    this.#replaceMatching((each) => each.id === id, { consumedAt: at })
    return true
  }

  /** The entity is frozen, so "updating" means rebuilding it in place. */
  #replaceMatching(
    matches: (verification: EmailVerification) => boolean,
    changes: { consumedAt?: Date; attempts?: number },
  ): void {
    this.verifications.forEach((verification, index) => {
      if (!matches(verification)) return

      this.verifications[index] = EmailVerification.fromTrusted({
        id: verification.id,
        userId: verification.userId,
        codeHash: verification.codeHash,
        expiresAt: verification.expiresAt,
        consumedAt: changes.consumedAt ?? verification.consumedAt,
        attempts: changes.attempts ?? verification.attempts,
        createdAt: verification.createdAt,
      })
    })
  }
}

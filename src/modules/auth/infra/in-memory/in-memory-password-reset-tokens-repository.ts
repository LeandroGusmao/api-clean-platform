import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import type {
  IPasswordResetTokensRepository,
  IssueOrRefreshParams,
} from '#modules/auth/repositories/password-reset-tokens-repository'

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Models
 * NO row lock and NO conditional-update race: a unit test runs one call at a
 * time. Atomicity is proved against real Postgres in
 * `tests/integration/drizzle-password-reset-tokens-repository.spec.ts`.
 */
export class InMemoryPasswordResetTokensRepository
  implements IPasswordResetTokensRepository
{
  readonly rows: PasswordResetToken[] = []

  async issueOrRefresh(params: IssueOrRefreshParams): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.userId === params.userId)

    if (index === -1) {
      this.rows.push(
        PasswordResetToken.fromTrusted({
          id: params.id,
          userId: params.userId,
          tokenHash: params.tokenHash,
          issuedAt: params.issuedAt,
          expiresAt: params.expiresAt,
          consumedAt: null,
          createdAt: params.issuedAt,
        }),
      )
      return true
    }

    const existing = this.rows[index]
    if (existing === undefined) return false
    // Mirrors the adapter's `WHERE issued_at <= cooldownCutoff`.
    if (existing.issuedAt.getTime() > params.cooldownCutoff.getTime()) return false

    this.rows[index] = PasswordResetToken.fromTrusted({
      id: existing.id,
      userId: existing.userId,
      tokenHash: params.tokenHash,
      issuedAt: params.issuedAt,
      expiresAt: params.expiresAt,
      consumedAt: null,
      createdAt: existing.createdAt,
    })
    return true
  }

  async findByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    return this.rows.find((row) => row.tokenHash === tokenHash) ?? null
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === id && row.consumedAt === null)
    if (index === -1) return false

    const row = this.rows[index]
    if (row === undefined) return false

    this.rows[index] = PasswordResetToken.fromTrusted({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      consumedAt: at,
      createdAt: row.createdAt,
    })
    return true
  }
}

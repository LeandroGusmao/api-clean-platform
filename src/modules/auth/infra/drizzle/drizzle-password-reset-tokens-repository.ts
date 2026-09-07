import { and, eq, isNull, lte } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import {
  findDriverError,
  PG_UNIQUE_VIOLATION,
  toPersistenceError,
} from '#infra/database/driver-error'
import type { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import type {
  IPasswordResetTokensRepository,
  IssueOrRefreshParams,
} from '#modules/auth/repositories/password-reset-tokens-repository'
import { toDomainPasswordResetToken } from './password-reset-token-mapper.js'
import {
  PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX,
  passwordResetTokens,
} from './schema/password-reset-tokens.js'

/** How many rows a conditional write affected when nothing matched its `WHERE`. */
const NO_ROW_AFFECTED = 0

const HASH_COLLISION_ERROR_NAME = 'PasswordResetTokenHashCollisionError'
const HASH_COLLISION_MESSAGE =
  'two password reset tokens produced the same sha256 digest: the opaque token ' +
  'generator has almost certainly regressed, and issued tokens may be predictable'

/**
 * Deliberately NOT an `AppError`, like `RefreshTokenHashCollisionError`: this is
 * a defect, not one of the semantic categories. It falls through to the error
 * handler's generic branch and answers 500, and carries no `code` because in
 * this project `code` is public contract and there is nothing a client could do
 * with this one. What it adds over the `PersistenceError` this would otherwise
 * be is the DIAGNOSIS.
 */
export class PasswordResetTokenHashCollisionError extends Error {
  constructor() {
    super(HASH_COLLISION_MESSAGE)
    this.name = HASH_COLLISION_ERROR_NAME
  }
}

/**
 * Matches the constraint NAME, not just the code: this table carries three
 * unique constraints — the primary key and `user_id` raise `23505` as well, and
 * matching the code alone would report a broken `IIdGenerator` as a compromised
 * token generator.
 */
function isTokenHashCollision(error: unknown): boolean {
  const driverError = findDriverError(error)

  return (
    driverError?.code === PG_UNIQUE_VIOLATION &&
    driverError.constraint === PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX
  )
}

export class DrizzlePasswordResetTokensRepository
  implements IPasswordResetTokensRepository
{
  constructor(private readonly db: Database) {}

  async issueOrRefresh(params: IssueOrRefreshParams): Promise<boolean> {
    try {
      const result = await this.db
        .insert(passwordResetTokens)
        .values({
          id: params.id,
          userId: params.userId,
          tokenHash: params.tokenHash,
          issuedAt: params.issuedAt,
          expiresAt: params.expiresAt,
          consumedAt: null,
          createdAt: params.issuedAt,
        })
        .onConflictDoUpdate({
          target: passwordResetTokens.userId,
          set: {
            tokenHash: params.tokenHash,
            issuedAt: params.issuedAt,
            expiresAt: params.expiresAt,
            // A fresh `forgot` revives an account whose last token was already
            // redeemed. `created_at` stays out of the SET: it dates the first.
            consumedAt: null,
          },
          // `setWhere`, not `targetWhere`: this must land on the `DO UPDATE`, so
          // a conflict inside the cooldown matches no row and writes nothing.
          setWhere: lte(passwordResetTokens.issuedAt, params.cooldownCutoff),
        })

      return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
    } catch (error) {
      // Named before the generic branch: 32 bytes of `randomBytes` do not
      // collide, so what produces this in practice is a regressed generator.
      if (isTokenHashCollision(error)) throw new PasswordResetTokenHashCollisionError()

      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this insert binds the digest.
      throw toPersistenceError(error)
    }
  }

  async findByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    try {
      const [row] = await this.db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, tokenHash))

      return row === undefined ? null : toDomainPasswordResetToken(row)
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this SELECT binds the digest.
      throw toPersistenceError(error)
    }
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: at })
      .where(and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.consumedAt)))

    // Its TS type is `number | null` (the pg client's own signature), so `null`
    // is treated as "matched nothing" rather than trusted as truthy: single use
    // must fail CLOSED, not open, if the driver ever surfaces `null`.
    return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
  }
}

import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import {
  findDriverError,
  PG_UNIQUE_VIOLATION,
  toPersistenceError,
} from '#infra/database/driver-error'
import type { RefreshToken } from '#modules/auth/entities/refresh-token'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import {
  toDomainRefreshToken,
  toPersistenceRefreshToken,
} from './refresh-token-mapper.js'
import {
  REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX,
  refreshTokens,
} from './schema/refresh-tokens.js'

/** Every lookup here returns at most one row. */
const SINGLE_ROW = 1

/** What `rowCount` means when the pg driver surfaces `null`. */
const NO_ROW_AFFECTED = 0

/**
 * Deliberately shorter than the connection-wide 5s of the connection-limits
 * slice. This is the hottest single row in the system, and every legitimate
 * holder finishes in milliseconds; five seconds of waiting is pooled
 * connections standing still exactly when contention already says the pool is
 * under pressure. What blows this timeout is `55P03`, which the transaction
 * runner deliberately does NOT retry — the client gets a 503 and can come back.
 */
export const ROTATION_LOCK_TIMEOUT_MS = 1_000

const HASH_COLLISION_ERROR_NAME = 'RefreshTokenHashCollisionError'
const HASH_COLLISION_MESSAGE =
  'two refresh tokens produced the same sha256 digest: the opaque token ' +
  'generator has almost certainly regressed, and issued tokens may be predictable'

/**
 * Deliberately NOT an `AppError`, for the same reason `PersistenceError` and
 * `NestedTransactionError` are not: this is a defect, not one of the seven
 * semantic categories. It falls through to the error handler's generic branch
 * and answers 500 — which is what it is. And it carries no `code`, because in
 * this project `code` on an error is PUBLIC CONTRACT (decision 13), and there
 * is nothing a client could do with this one.
 *
 * What it adds over the `PersistenceError` this would otherwise become is not
 * data: that error already reaches the log carrying `code: '23505'` and the
 * constraint name, and a dropped connection carries neither, so the two are
 * already distinguishable. What it adds is the DIAGNOSIS — whoever is woken by
 * this should not have to work out from an index name that the entropy source
 * is broken.
 */
export class RefreshTokenHashCollisionError extends Error {
  constructor() {
    super(HASH_COLLISION_MESSAGE)
    this.name = HASH_COLLISION_ERROR_NAME
  }
}

/**
 * Matches the constraint NAME, not just the code: this table carries a second
 * unique constraint — its primary key — so an id collision raises `23505` as
 * well, and matching the code alone would report a broken `IIdGenerator` as a
 * compromised token generator. That one keeps bubbling as a `PersistenceError`:
 * a repeated UUID fails a request, it does not make a session guessable.
 */
function isTokenHashCollision(error: unknown): boolean {
  const driverError = findDriverError(error)

  return (
    driverError?.code === PG_UNIQUE_VIOLATION &&
    driverError.constraint === REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX
  )
}

export class DrizzleRefreshTokensRepository implements IRefreshTokensRepository {
  constructor(private readonly db: Database) {}

  async save(token: RefreshToken): Promise<void> {
    try {
      await this.db.insert(refreshTokens).values(toPersistenceRefreshToken(token))
    } catch (error) {
      // Named before the generic branch: this is the rarest and most suspicious
      // failure the module can produce, and it must not read as "the database
      // rejected a statement".
      if (isTokenHashCollision(error)) throw new RefreshTokenHashCollisionError()

      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this insert binds the digest
      // that IS the lookup key for a live session.
      throw toPersistenceError(error)
    }
  }

  async findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null> {
    try {
      // `sql.raw`, not a bound parameter: Postgres rejects `SET LOCAL x = $1`
      // with 42601 — SET takes no parameters. Safe only because the value is a
      // compile-time constant; never interpolate anything that came from a
      // request. `SET LOCAL` reverts at COMMIT, so the pooled connection goes
      // back with the connection-wide default intact (verified).
      await this.db.execute(
        sql`SET LOCAL lock_timeout = ${sql.raw(String(ROTATION_LOCK_TIMEOUT_MS))}`,
      )

      const [row] = await this.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(SINGLE_ROW)
        // The whole reuse detection rests on this. Without it, two simultaneous
        // refreshes of the same token both read it as active and both rotate.
        .for('update')

      return row === undefined ? null : toDomainRefreshToken(row)
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this SELECT binds the digest
      // that IS the lookup key for a live session. Safe on this in-transaction
      // path because `toPersistenceError` preserves `code` — the `55P03` from
      // the `SET LOCAL` above still reaches the runner as transient.
      throw toPersistenceError(error)
    }
  }

  async markRotated(id: string, replacedBy: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt, replacedBy })
      .where(eq(refreshTokens.id, id))
  }

  async revoke(id: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt })
      // `isNull` for the same reason as below: re-revoking must not push an
      // already-dead token's instant forward.
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
  }

  async revokeFamily(familyId: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt })
      // `isNull` is not decoration: without it an already-revoked token would
      // have its `revokedAt` pushed forward, sliding the grace window of a
      // token that should already be dead.
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
  }

  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(refreshTokens)
      .where(lte(refreshTokens.expiresAt, cutoff))

    return result.rowCount ?? NO_ROW_AFFECTED
  }
}

import type { RefreshToken } from '#modules/auth/entities/refresh-token'

/**
 * Commands rather than a mutable entity, and the reason is `revokeFamily`:
 * revoking a chain is ONE `UPDATE`, while "load every entity, revoke each, save
 * each" would be N reads and N writes for the same effect — slower, locking
 * more rows, and still able to miss a row inserted in between.
 */
export interface IRefreshTokensRepository {
  save(token: RefreshToken): Promise<void>

  /**
   * Finds by digest and LOCKS the row (`SELECT ... FOR UPDATE`).
   *
   * Only meaningful inside a transaction: outside one the lock is released at
   * the end of the statement, which is the same as no lock at all. The lock is
   * what makes reuse detection possible — without it two simultaneous refreshes
   * of the same token both read it as active and both rotate, and no reuse is
   * ever detected.
   */
  findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null>

  /** Revokes one token and points it at its successor, in a single write. */
  markRotated(id: string, replacedBy: string, revokedAt: Date): Promise<void>

  /**
   * Revokes ONE token outright, with no `replacedBy`.
   *
   * The absence of a successor is the whole point: a replay of a token revoked
   * this way lands in reuse detection rather than in the grace window, because
   * only a revocation that recorded a successor counts as a rotation.
   *
   * Touches only a still-active row and returns how many it revoked: zero means
   * the token was already dead, which is how the grace window tells a
   * successor that is still live from one an explicit revocation already
   * killed.
   */
  revoke(id: string, revokedAt: Date): Promise<number>

  /**
   * Revokes every still-active token of one chain and returns how many it
   * revoked. Zero means the chain was already dead — that is what lets a caller
   * tell the revocation that just happened from a replay that found nothing
   * left to revoke.
   *
   * A successor that a concurrent rotation of this chain is inserting is
   * revoked too: the call waits for that rotation to commit.
   */
  revokeFamily(familyId: string, revokedAt: Date): Promise<number>

  /**
   * Revokes every still-active token of one user, across every chain —
   * including a successor that a concurrent rotation is inserting: the call
   * waits for that rotation to commit. Otherwise a stolen token refreshed in a
   * loop could outlive a logout-all or a password change.
   */
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>

  /**
   * One row per still-active session: `SELECT ... WHERE user_id = ? AND
   * revoked_at IS NULL AND expires_at > ?`. No `GROUP BY` needed — rotation
   * always revokes the row it replaces in the same write, so a family has at
   * most one unrevoked row at any instant, and that row already IS the
   * session's current state. Exclusive at the expiry boundary, matching
   * `RefreshToken.isExpired`: an instant that has arrived is spent.
   */
  findActiveByUserId(userId: string, now: Date): Promise<RefreshToken[]>

  /**
   * Full sweep for the cron. Deletes every row whose `expires_at` is at or
   * before `cutoff`; the use case passes `clock.now() - retention`, so a dead
   * row lingers one retention window and stays available for a post-mortem
   * after a session bug. Returns the deleted-row count for the run log.
   *
   * An unconditional `DELETE`: no transaction, no lock, no ordering. The prune
   * tables share no invariant, and `replaced_by` carries no FK
   * exactly so a chain need not be deleted in order.
   */
  deleteExpiredBefore(cutoff: Date): Promise<number>
}

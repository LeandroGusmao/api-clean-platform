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
   */
  revoke(id: string, revokedAt: Date): Promise<void>

  /** Revokes every still-active token of one chain. */
  revokeFamily(familyId: string, revokedAt: Date): Promise<void>

  /** Revokes every still-active token of one user, across every chain. */
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>

  /**
   * Full sweep for the cron. Deletes every row whose `expires_at` is at or
   * before `cutoff`; the use case passes `clock.now() - retention`, so a dead
   * row lingers one retention window and stays available for a post-mortem
   * (design §3.4). Returns the deleted-row count for the run log.
   *
   * An unconditional `DELETE`: no transaction, no lock, no ordering. The prune
   * tables share no invariant, and `replaced_by` carries no FK (decision 11)
   * exactly so a chain need not be deleted in order.
   */
  deleteExpiredBefore(cutoff: Date): Promise<number>
}

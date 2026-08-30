import type { IUnitOfWork } from '#shared/ports/unit-of-work'
import type { Database } from './client.js'
import type { TransactionRunner } from './transaction-runner.js'

/**
 * Pairs the context-free runner with a factory that binds repositories to the
 * transaction. Every module plugs in the same way, so the transaction mechanics
 * are never duplicated — and a use case that legitimately spans two modules
 * merges their factories onto the SAME transaction instead of stacking two
 * units of work, which would be two transactions:
 *
 * ```ts
 * createUnitOfWork(runner, (tx) => ({
 *   ...authRepositories(tx),
 *   ...billingRepositories(tx),
 * }))
 * ```
 */
export function createUnitOfWork<TRepos>(
  runner: TransactionRunner,
  buildRepos: (db: Database) => TRepos,
): IUnitOfWork<TRepos> {
  return <T>(work: (repos: TRepos) => Promise<T>): Promise<T> =>
    runner((tx) => work(buildRepos(tx)))
}

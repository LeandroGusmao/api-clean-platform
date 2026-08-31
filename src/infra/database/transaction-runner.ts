import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { WarnLogger } from '#infra/observability/logger'
import { TransientError } from '#shared/errors/app-error'
import type { Database } from './client.js'
import { findDriverError } from './driver-error.js'

/**
 * The context-free half of the Unit of Work: it knows how to open a transaction
 * and nothing about repositories. Build ONE per process, in the composition
 * root, and share it with every module's Unit of Work.
 */
export type TransactionRunner = <T>(work: (tx: Database) => Promise<T>) => Promise<T>

const NESTED_TRANSACTION_ERROR_NAME = 'NestedTransactionError'
const NESTED_TRANSACTION_MESSAGE =
  'a transaction is already open on this async context: open it once at the ' +
  'use case boundary and reuse the transaction-bound repositories'

/**
 * Deliberately NOT an `AppError`, for the same reason `PersistenceError` is not:
 * nesting is a programming defect, not one of the six semantic categories of
 * decision 13. It falls through to the error handler's generic branch and
 * answers 500 — which is what it is.
 */
export class NestedTransactionError extends Error {
  constructor() {
    super(NESTED_TRANSACTION_MESSAGE)
    this.name = NESTED_TRANSACTION_ERROR_NAME
  }
}

const TRANSACTION_CONFLICT_ERROR_NAME = 'TransactionConflictError'
const TRANSACTION_CONFLICT_CODE = 'TRANSACTION_CONFLICT'
const TRANSACTION_CONFLICT_MESSAGE =
  'the transaction conflicted with a concurrent one and could not complete'

const RETRY_LOG_MESSAGE = 'retrying transaction after a transient failure'

const DEADLOCK_DETECTED = '40P01'
const SERIALIZATION_FAILURE = '40001'
const LOCK_NOT_AVAILABLE = '55P03'

/**
 * Worth retrying because Postgres has ALREADY broken the tie: it kills one of
 * the two transactions precisely so the other can proceed, so the victim
 * reaches the next attempt with a clear path and usually succeeds at once.
 * That is why the cap is small — this is not a network timeout being guessed at.
 */
const RETRIABLE_SQLSTATES: ReadonlySet<string> = new Set([
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
])

/**
 * Transient for the client, but `55P03` is not retried here: it means the lock
 * timeout elapsed, and the holder is still there. Retrying is waiting another
 * full `lock_timeout` to fail again while holding a pooled connection — under
 * the very contention that caused it. The client gets a 503 and can come back.
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  ...RETRIABLE_SQLSTATES,
  LOCK_NOT_AVAILABLE,
])

const FIRST_ATTEMPT = 1
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 25
const BACKOFF_FACTOR = 2

/**
 * A transient database conflict that survived every retry.
 *
 * Carries **no `cause`**, for the same reason `PersistenceError` carries none:
 * pino's serializer concatenates the cause chain into the parent's message, and
 * the driver error underneath holds the query's bound parameters. The SQLSTATE
 * and the attempt count diagnose it without carrying a payload.
 */
export class TransactionConflictError extends TransientError {
  readonly code = TRANSACTION_CONFLICT_CODE
  readonly sqlstate: string
  readonly attempts: number

  constructor(sqlstate: string, attempts: number) {
    super(TRANSACTION_CONFLICT_MESSAGE)
    this.name = TRANSACTION_CONFLICT_ERROR_NAME
    this.sqlstate = sqlstate
    this.attempts = attempts
  }
}

/**
 * Full jitter over an exponential base. The jitter is the point: two victims of
 * the same deadlock that backed off by a fixed delay would return in lockstep
 * and collide again.
 *
 * `Math.random()` is allowed here because this is infrastructure — R7 forbids it
 * in the pure layer, where it would make a test non-deterministic.
 */
function backoffFor(attempt: number): number {
  return Math.random() * BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - FIRST_ATTEMPT)
}

/**
 * Tracks whether the current async context already holds an open transaction.
 * Read ONLY by the guard below: repositories never touch it, and the only
 * thing a positive read can do is throw.
 *
 * The store holds a mutable box rather than a bare `true` because the context
 * entered by `insideTransaction.run` outlives the transaction: any async
 * resource created inside `work` (a `setTimeout`, a detached retry, an outbox
 * flush) inherits the same context and would otherwise read the store as
 * "still inside a transaction" forever, long after the connection returned to
 * the pool. Closing the box in `finally` — rather than never closing it —
 * means that work is allowed once the transaction has settled, while a
 * genuine nested call made DURING the transaction (still `open: true`) is
 * still blocked.
 *
 * That is what separates it from the ambient-transaction pattern decision 22
 * rejected — the transaction stays explicit in `work`'s parameter, and the
 * only thing this flag can do is throw. It is the project's second use of
 * `AsyncLocalStorage`, which decision 15 had accepted as a one-off; the
 * amendment records why detection is not propagation.
 */
const insideTransaction = new AsyncLocalStorage<{ open: boolean }>()

/**
 * One attempt, with its own box. It opens with the transaction and closes the
 * moment the transaction settles — before any retry logic runs, so the backoff
 * that follows a failure does not execute inside a context still claiming a
 * transaction is open.
 */
async function runAttempt<T>(
  db: Database,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  const state = { open: true }

  try {
    return await insideTransaction.run(state, () => db.transaction((tx) => work(tx)))
  } finally {
    state.open = false
  }
}

export function createTransactionRunner(
  db: Database,
  logger: WarnLogger,
): TransactionRunner {
  return async <T>(work: (tx: Database) => Promise<T>): Promise<T> => {
    // A second call would take ANOTHER pooled connection and open an
    // independent transaction — not a savepoint. It would commit on its own
    // while the outer one rolls back, and deadlock outright whenever the outer
    // holds a row lock the inner asks for. Postgres cannot break that one: the
    // outer transaction is not waiting on a lock, it is waiting on JavaScript.
    //
    // The read happens synchronously, before the first `await`, so it runs in
    // the CALLER's async context regardless of `createTransactionRunner`
    // itself now being `async` — the guard's semantics are unchanged. Making
    // the function `async` only changes what happens when the guard fires:
    // the `throw` below becomes a rejection of the returned promise instead of
    // a synchronous throw out of a function typed `Promise<T>`, which is what
    // let it surface as an uncaught exception in a detached caller that has no
    // enclosing `try` and no `.catch()` attached yet.
    if (insideTransaction.getStore()?.open === true) throw new NestedTransactionError()

    for (let attempt = FIRST_ATTEMPT; ; attempt += 1) {
      try {
        return await runAttempt(db, work)
      } catch (error) {
        // Runs OUTSIDE the storage scope: `await insideTransaction.run(...)`
        // hands control back to the caller's context, so the decision, the log
        // and the backoff below all happen with no store active.
        const sqlstate = findDriverError(error)?.code

        if (sqlstate === undefined || !TRANSIENT_SQLSTATES.has(sqlstate)) throw error

        if (!RETRIABLE_SQLSTATES.has(sqlstate) || attempt === MAX_ATTEMPTS) {
          throw new TransactionConflictError(sqlstate, attempt)
        }

        logger.warn({ sqlstate, attempt }, RETRY_LOG_MESSAGE)
        await sleep(backoffFor(attempt))
      }
    }
  }
}

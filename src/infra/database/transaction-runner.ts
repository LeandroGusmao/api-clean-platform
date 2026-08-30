import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from './client.js'

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

export function createTransactionRunner(db: Database): TransactionRunner {
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

    const state = { open: true }

    try {
      return await insideTransaction.run(state, () => db.transaction((tx) => work(tx)))
    } finally {
      state.open = false
    }
  }
}

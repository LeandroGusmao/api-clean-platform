import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '#infra/database/client'
import {
  createTransactionRunner,
  NestedTransactionError,
  TransactionConflictError,
} from '#infra/database/transaction-runner'

const WORK_RESULT = 'work-result'
const COLLABORATOR_RESULT = 'collaborator-result'
const BOOM_MESSAGE = 'boom — abort the transaction'
const DEFERRED_WORK_DELAY_MS = 0

/**
 * The runner only ever calls `.transaction`, so the double implements that and
 * nothing else. `Database` is Drizzle's complete handle type, hence the cast —
 * confined to these two lines, in a file that never reaches `dist/`.
 */
const TRANSACTION_HANDLE = { handle: 'tx' } as unknown as Database

const db = {
  transaction: <T>(work: (tx: Database) => Promise<T>): Promise<T> =>
    work(TRANSACTION_HANDLE),
} as unknown as Database

// Wire contract, spelled out rather than imported: these ARE what the retry
// policy is asserted against, and importing them would make it tautological.
const DEADLOCK_DETECTED = '40P01'
const SERIALIZATION_FAILURE = '40001'
const LOCK_NOT_AVAILABLE = '55P03'
const MAX_ATTEMPTS = 3

const RETRY_LOG_MESSAGE = 'retrying transaction after a transient failure'

interface WarnCall {
  details: Record<string, unknown>
  message: string
}

let warnings: WarnCall[]

const logger = {
  warn: (details: Record<string, unknown>, message: string) => {
    warnings.push({ details, message })
  },
}

beforeEach(() => {
  warnings = []
})

/**
 * Shaped like what the driver actually throws: `findDriverError` walks the
 * `cause` chain looking for a `code`, so the retry policy reads this exactly as
 * it would read a real `pg` failure.
 */
function driverError(code: string): Error {
  return Object.assign(new Error(`postgres said ${code}`), { code })
}

/** Fails the first `failures` attempts, then succeeds. Counts every attempt. */
function workFailing(failures: number, code: string) {
  const state = { attempts: 0 }
  const work = async (): Promise<string> => {
    state.attempts += 1
    if (state.attempts <= failures) throw driverError(code)

    return WORK_RESULT
  }

  return { work, state }
}

describe('createTransactionRunner', () => {
  it('hands the transaction handle to the work and returns its result', async () => {
    const runner = createTransactionRunner(db, logger)
    let received: Database | undefined

    const result = await runner(async (tx) => {
      received = tx
      return WORK_RESULT
    })

    expect(result).toBe(WORK_RESULT)
    expect(received).toBe(TRANSACTION_HANDLE)
  })

  it('propagates the error the work throws, unwrapped', async () => {
    const runner = createTransactionRunner(db, logger)
    const boom = new Error(BOOM_MESSAGE)

    // `toBe`, not `toThrow`: identity is the contract. A wrapped error would
    // still satisfy a message match while breaking the error taxonomy, which
    // is what lets `EmailAlreadyInUseError` still answer 409 from inside
    // a transaction.
    await expect(
      runner(async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
  })

  it('throws when a runner is called inside another runner', async () => {
    const runner = createTransactionRunner(db, logger)

    await expect(
      runner(async () => runner(async () => WORK_RESULT)),
    ).rejects.toBeInstanceOf(NestedTransactionError)
  })

  it('throws when the nesting comes from a collaborator, across an await', async () => {
    const runner = createTransactionRunner(db, logger)

    const collaborator = async (): Promise<string> => {
      // Crossing a microtask boundary is the point: the flag has to survive it.
      // That is what proves detection is by async context, and not by anything
      // that could be read off the synchronous call stack.
      await Promise.resolve()

      return runner(async () => COLLABORATOR_RESULT)
    }

    await expect(runner(async () => collaborator())).rejects.toBeInstanceOf(
      NestedTransactionError,
    )
  })

  it('does not trip the guard on a second, sequential run', async () => {
    const runner = createTransactionRunner(db, logger)

    await runner(async () => WORK_RESULT)

    // Without this one, a storage whose context is never exited passes all four
    // tests above and then rejects the second request of every process.
    await expect(runner(async () => WORK_RESULT)).resolves.toBe(WORK_RESULT)
  })

  /**
   * The exact shape `RegisterUserUseCase` relies on: the first transaction
   * FAILS, the caller catches, and the recovery path opens a second one from
   * inside that `catch`.
   *
   * Measured rather than assumed, because two independent mechanisms have to
   * hold for it and either one failing would turn every registration on a
   * taken address into a 500. First, `runAttempt` closes its box in `finally`,
   * which runs when the transaction SETTLES — a rejection included — so the
   * flag is already `false` by the time the rejection reaches the caller.
   * Second, the `catch` resumes in the caller's own async context, the one
   * that existed before `insideTransaction.run` was ever entered, so there is
   * no store to read there at all.
   */
  it('allows a second run opened from the catch of a failed one', async () => {
    const runner = createTransactionRunner(db, logger)
    const boom = new Error(BOOM_MESSAGE)
    let recovered: string | undefined

    try {
      await runner(async () => {
        throw boom
      })
    } catch {
      recovered = await runner(async () => COLLABORATOR_RESULT)
    }

    expect(recovered).toBe(COLLABORATOR_RESULT)
  })

  it('does not trip the guard on runs that overlap', async () => {
    const runner = createTransactionRunner(db, logger)
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = runner(async () => {
      await barrier
      return WORK_RESULT
    })
    const second = runner(async () => COLLABORATOR_RESULT)

    release?.()

    // A per-instance counter, rejected in §5.4 of the design spec, would trip
    // here: two concurrent requests through the same singleton runner are not
    // nesting, and the guard has to tell them apart from a genuine nested call
    // by async context rather than by how many runs are in flight at once.
    await expect(Promise.all([first, second])).resolves.toEqual([
      WORK_RESULT,
      COLLABORATOR_RESULT,
    ])
  })

  it('allows work scheduled after the transaction has already committed', async () => {
    const runner = createTransactionRunner(db, logger)
    let deferred: Promise<string> | undefined

    await runner(async () => {
      // Detached on purpose: nothing here awaits this `setTimeout`, so it
      // fires after `work` has returned and the transaction has committed —
      // exactly the retry/outbox-flush shape from the finding. It still runs
      // inside the async context `insideTransaction.run` created for this
      // call, so a store that never closes would read that context as "still
      // inside a transaction" and reject this call with a false
      // `NestedTransactionError`.
      deferred = new Promise<string>((resolve) => {
        setTimeout(
          () => resolve(runner(async () => COLLABORATOR_RESULT)),
          DEFERRED_WORK_DELAY_MS,
        )
      })

      return WORK_RESULT
    })

    await expect(deferred).resolves.toBe(COLLABORATOR_RESULT)
  })

  it('retries a deadlock and succeeds on the next attempt', async () => {
    const runner = createTransactionRunner(db, logger)
    const { work, state } = workFailing(1, DEADLOCK_DETECTED)

    await expect(runner(work)).resolves.toBe(WORK_RESULT)
    expect(state.attempts).toBe(2)
  })

  it('retries a serialization failure the same way', async () => {
    const runner = createTransactionRunner(db, logger)
    const { work, state } = workFailing(1, SERIALIZATION_FAILURE)

    await expect(runner(work)).resolves.toBe(WORK_RESULT)
    expect(state.attempts).toBe(2)
  })

  // The lock holder is still there, so a retry means waiting another full
  // `lock_timeout` to fail again while holding a pooled connection. Transient
  // for the client, not worth insisting on from the server.
  it('does not retry a lock timeout, but still reports it as transient', async () => {
    const runner = createTransactionRunner(db, logger)
    const { work, state } = workFailing(MAX_ATTEMPTS, LOCK_NOT_AVAILABLE)

    await expect(runner(work)).rejects.toBeInstanceOf(TransactionConflictError)
    expect(state.attempts).toBe(1)
  })

  it('does not retry a failure that is not transient', async () => {
    const runner = createTransactionRunner(db, logger)
    const boom = new Error(BOOM_MESSAGE)
    let attempts = 0

    await expect(
      runner(async () => {
        attempts += 1
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(attempts).toBe(1)
  })

  it('gives up after the attempt cap and reports the conflict', async () => {
    const runner = createTransactionRunner(db, logger)
    const { work, state } = workFailing(MAX_ATTEMPTS, DEADLOCK_DETECTED)

    await expect(runner(work)).rejects.toBeInstanceOf(TransactionConflictError)
    expect(state.attempts).toBe(MAX_ATTEMPTS)
  })

  // A retry that resolves the deadlock leaves no trace in any error metric, so
  // without this line an epidemic of contention is invisible until it is bad
  // enough to exhaust the retries.
  it('logs every retry with the SQLSTATE that caused it', async () => {
    const runner = createTransactionRunner(db, logger)
    const { work } = workFailing(1, DEADLOCK_DETECTED)

    await runner(work)

    expect(warnings).toEqual([
      {
        details: { sqlstate: DEADLOCK_DETECTED, attempt: 1 },
        message: RETRY_LOG_MESSAGE,
      },
    ])
  })

  // Each attempt needs its own box. Sharing one across the loop would leave it
  // open during the backoff, and reusing a closed one would let a genuine
  // nested call through on attempt two.
  it('keeps the nesting guard armed on every attempt', async () => {
    const runner = createTransactionRunner(db, logger)
    let attempts = 0

    await expect(
      runner(async () => {
        attempts += 1
        if (attempts === 1) throw driverError(DEADLOCK_DETECTED)

        return runner(async () => WORK_RESULT)
      }),
    ).rejects.toBeInstanceOf(NestedTransactionError)
    expect(attempts).toBe(2)
  })
})

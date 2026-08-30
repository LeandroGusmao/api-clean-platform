import { describe, expect, it } from 'vitest'
import type { Database } from '#infra/database/client'
import {
  createTransactionRunner,
  NestedTransactionError,
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

describe('createTransactionRunner', () => {
  it('hands the transaction handle to the work and returns its result', async () => {
    const runner = createTransactionRunner(db)
    let received: Database | undefined

    const result = await runner(async (tx) => {
      received = tx
      return WORK_RESULT
    })

    expect(result).toBe(WORK_RESULT)
    expect(received).toBe(TRANSACTION_HANDLE)
  })

  it('propagates the error the work throws, unwrapped', async () => {
    const runner = createTransactionRunner(db)
    const boom = new Error(BOOM_MESSAGE)

    // `toBe`, not `toThrow`: identity is the contract. A wrapped error would
    // still satisfy a message match while breaking the taxonomy of decision 13,
    // which is what lets `EmailAlreadyInUseError` still answer 409 from inside
    // a transaction.
    await expect(
      runner(async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
  })

  it('throws when a runner is called inside another runner', async () => {
    const runner = createTransactionRunner(db)

    await expect(
      runner(async () => runner(async () => WORK_RESULT)),
    ).rejects.toBeInstanceOf(NestedTransactionError)
  })

  it('throws when the nesting comes from a collaborator, across an await', async () => {
    const runner = createTransactionRunner(db)

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
    const runner = createTransactionRunner(db)

    await runner(async () => WORK_RESULT)

    // Without this one, a storage whose context is never exited passes all four
    // tests above and then rejects the second request of every process.
    await expect(runner(async () => WORK_RESULT)).resolves.toBe(WORK_RESULT)
  })

  it('does not trip the guard on runs that overlap', async () => {
    const runner = createTransactionRunner(db)
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
    const runner = createTransactionRunner(db)
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
})

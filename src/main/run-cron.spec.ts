import { describe, expect, it } from 'vitest'
import type { CronJob } from '#shared/ports/cron-job'
import {
  CRON_EXIT_JOB_FAILED,
  CRON_EXIT_OK,
  CronInvocationError,
  cronExitCode,
  jobArgFrom,
  qualify,
  runJobs,
  selectJobs,
} from './run-cron.js'

const THREE = 3
const ZERO = 0
const ONE = 1
const TWO = 2

const NODE = '/usr/bin/node'
const SCRIPT = '/app/dist/main/cron.js'

const okJob = (name: string, rowsDeleted: number): CronJob => ({
  name,
  run: async () => ({ rowsDeleted }),
})

const throwingJob = (name: string): CronJob => ({
  name,
  run: async () => {
    throw new Error(`${name} blew up`)
  },
})

describe('runJobs', () => {
  it('runs every job in order and returns one outcome per job', async () => {
    const outcomes = await runJobs([okJob('first', THREE), okJob('second', ZERO)])

    expect(outcomes.map((outcome) => outcome.name)).toEqual(['first', 'second'])
    expect(outcomes[0]?.metrics).toEqual({ rowsDeleted: THREE })
    expect(outcomes[1]?.metrics).toEqual({ rowsDeleted: ZERO })
    expect(outcomes.every((outcome) => outcome.error === undefined)).toBe(true)
  })

  it('records a throwing job and still runs the ones after it', async () => {
    const outcomes = await runJobs([throwingJob('bad'), okJob('good', ONE)])

    expect(outcomes[0]?.name).toBe('bad')
    expect(outcomes[0]?.error).toBeInstanceOf(Error)
    expect(outcomes[0]?.metrics).toBeUndefined()
    expect(outcomes[1]?.name).toBe('good')
    expect(outcomes[1]?.metrics).toEqual({ rowsDeleted: ONE })
  })
})

describe('cronExitCode', () => {
  it('is OK when every outcome succeeded', () => {
    expect(
      cronExitCode([{ name: 'a', durationMs: ONE, metrics: { rowsDeleted: ZERO } }]),
    ).toBe(CRON_EXIT_OK)
  })

  it('is the failure code when any outcome carries an error', () => {
    expect(
      cronExitCode([
        { name: 'a', durationMs: ONE, metrics: {} },
        { name: 'b', durationMs: ONE, error: new Error('x') },
      ]),
    ).toBe(CRON_EXIT_JOB_FAILED)
  })
})

describe('qualify', () => {
  it('prefixes every job with its module, leaving run untouched', async () => {
    const [first, second] = qualify('auth', [
      okJob('prune-a', ONE),
      okJob('prune-b', TWO),
    ])

    expect(first?.name).toBe('auth:prune-a')
    expect(second?.name).toBe('auth:prune-b')
    expect(await first?.run()).toEqual({ rowsDeleted: ONE })
  })

  it('does not mutate the jobs it was given', () => {
    const original = okJob('prune-a', ONE)

    qualify('auth', [original])

    expect(original.name).toBe('prune-a')
  })
})

describe('jobArgFrom', () => {
  it('is undefined when no selector was passed', () => {
    expect(jobArgFrom([NODE, SCRIPT])).toBeUndefined()
  })

  it('reads the first argument after the script', () => {
    expect(jobArgFrom([NODE, SCRIPT, 'auth:prune-a'])).toBe('auth:prune-a')
  })

  it('rejects more than one argument rather than ignoring the extras', () => {
    // The TYPE matters, not just the throw: `cron.ts` answers exit 2 only for
    // CronInvocationError, and exit 1 for anything else that goes wrong.
    expect(() => jobArgFrom([NODE, SCRIPT, 'auth', 'billing'])).toThrow(
      CronInvocationError,
    )
  })
})

describe('selectJobs', () => {
  const jobs = [
    okJob('auth:prune-a', ONE),
    okJob('auth:prune-b', TWO),
    okJob('billing:reconcile', THREE),
  ]

  it('returns every job when no selector is given', () => {
    expect(selectJobs(jobs).map((job) => job.name)).toEqual([
      'auth:prune-a',
      'auth:prune-b',
      'billing:reconcile',
    ])
  })

  it('selects every job of one module by its bare name', () => {
    expect(selectJobs(jobs, 'auth').map((job) => job.name)).toEqual([
      'auth:prune-a',
      'auth:prune-b',
    ])
  })

  it('selects a single job by its qualified name', () => {
    expect(selectJobs(jobs, 'auth:prune-b').map((job) => job.name)).toEqual([
      'auth:prune-b',
    ])
  })

  it('throws for an unknown target, naming the valid ones', () => {
    // The message is what an operator reads after a typo in a task definition,
    // so it has to carry the list rather than just refuse.
    expect(() => selectJobs(jobs, 'auth:prune-typo')).toThrow(
      /unknown cron target.*auth:prune-a.*billing:reconcile/s,
    )
    expect(() => selectJobs(jobs, 'auth:prune-typo')).toThrow(CronInvocationError)
  })

  it('does not match a module prefix that is only a partial word', () => {
    expect(() => selectJobs(jobs, 'aut')).toThrow(CronInvocationError)
  })
})

import { describe, expect, it } from 'vitest'
import type { CronJob } from '#shared/ports/cron-job'
import { CRON_EXIT_JOB_FAILED, CRON_EXIT_OK, cronExitCode, runJobs } from './run-cron.js'

const THREE = 3
const ZERO = 0
const ONE = 1

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

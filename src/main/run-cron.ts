import { performance } from 'node:perf_hooks'
import type { Env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import type { AppLogger } from '#infra/observability/logger'
import type { CronJob } from '#shared/ports/cron-job'
import { makeContainer } from './container.js'

export const CRON_EXIT_OK = 0
export const CRON_EXIT_JOB_FAILED = 1

export interface JobOutcome {
  name: string
  durationMs: number
  /** Present when the job returned. Merged into the run log. */
  metrics?: Record<string, number>
  /** Present when the job threw. */
  error?: unknown
}

/**
 * Runs each job in order, isolating failures: a job that throws is recorded and
 * the next still runs. Split from `runCron` so the loop is unit-testable with no
 * database. Serial and not parallel — a one-shot has no deadline, and serial
 * keeps database load predictable and the log readable (design §5.1).
 */
export async function runJobs(jobs: readonly CronJob[]): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = []
  for (const job of jobs) {
    const start = performance.now()
    try {
      const metrics = await job.run()
      outcomes.push({ name: job.name, durationMs: performance.now() - start, metrics })
    } catch (error) {
      outcomes.push({ name: job.name, durationMs: performance.now() - start, error })
    }
  }
  return outcomes
}

export function cronExitCode(outcomes: readonly JobOutcome[]): number {
  return outcomes.some((outcome) => outcome.error !== undefined)
    ? CRON_EXIT_JOB_FAILED
    : CRON_EXIT_OK
}

/**
 * Builds the framework-free graph (decision 10), runs every module's cron jobs,
 * and closes the pool. Does not log or call `process.exit` — `cron.ts` owns
 * both, so this stays a function returning data.
 */
export async function runCron(env: Env, logger: AppLogger): Promise<JobOutcome[]> {
  const { db, pool } = createDatabase(env)
  try {
    const container = makeContainer(db, env, logger)
    return await runJobs([...container.auth.jobs])
  } finally {
    await pool.end()
  }
}

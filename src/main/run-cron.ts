import { performance } from 'node:perf_hooks'
import type { Env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import type { AppLogger } from '#infra/observability/logger'
import type { CronJob } from '#shared/ports/cron-job'
import { makeContainer } from './container.js'

export const CRON_EXIT_OK = 0
/** A job ran and threw. */
export const CRON_EXIT_JOB_FAILED = 1
/**
 * The command line named a target that does not exist. Deliberately distinct
 * from `CRON_EXIT_JOB_FAILED`: this is a broken task definition, not a broken
 * job, and an alert that conflates the two pages the wrong person.
 */
export const CRON_EXIT_BAD_INVOCATION = 2

/**
 * Separates the module from the job in a target name: `auth:prune-expired-…`.
 * Exported with `AUTH_MODULE` because together they are the vocabulary an
 * operator types on the command line — a caller composing a target should read
 * it from here rather than spell the format again.
 */
export const JOB_NAME_SEPARATOR = ':'

/** `process.argv` is `[node, script, ...args]`; the target is the first real arg. */
const SELECTOR_ARG_INDEX = 2
/** node + script + at most one target. */
const MAX_ARGV_LENGTH = 3

const TOO_MANY_ARGS = 'expected at most one cron target'
const UNKNOWN_TARGET = 'unknown cron target'
const CRON_INVOCATION_ERROR_NAME = 'CronInvocationError'

/**
 * The command line asked for something that does not exist. Its own type so the
 * shell can answer `CRON_EXIT_BAD_INVOCATION` for it and keep the ordinary
 * failure code for everything else that can go wrong on the way — a database
 * that refuses the connection is not a broken task definition.
 *
 * Not an `AppError`: this never reaches HTTP and has no client-facing `code`.
 */
export class CronInvocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = CRON_INVOCATION_ERROR_NAME
  }
}

/**
 * Every module whose jobs this entrypoint runs. Listed by hand, like the route
 * prefixes in `app.ts`: a module that registers jobs and is missed here is
 * silently never pruned, so the line has to be visible in a diff.
 */
export const AUTH_MODULE = 'auth'

export interface JobOutcome {
  name: string
  durationMs: number
  /** Present when the job returned. Merged into the run log. */
  metrics?: Record<string, number>
  /** Present when the job threw. */
  error?: unknown
}

/**
 * Prefixes a module's jobs with its name, so two modules cannot publish the
 * same target. Done HERE, at the point of concatenation, rather than by each
 * module naming its own jobs: there the prefix would be a convention an author
 * can forget, and collisions would be back.
 *
 * Lives next to `selectJobs` because the two are halves of one format — this
 * one writes `module:job`, that one parses it. Split across files, the
 * separator and the format drift apart.
 */
export function qualify(moduleName: string, jobs: readonly CronJob[]): CronJob[] {
  return jobs.map((job) => ({
    ...job,
    name: `${moduleName}${JOB_NAME_SEPARATOR}${job.name}`,
  }))
}

/** Reads the optional target from `process.argv`. */
export function jobArgFrom(argv: readonly string[]): string | undefined {
  if (argv.length > MAX_ARGV_LENGTH) throw new CronInvocationError(TOO_MANY_ARGS)

  return argv[SELECTOR_ARG_INDEX]
}

/**
 * No selector runs everything; a bare module name runs that module's jobs; a
 * qualified name runs the one job. A selector that matches nothing throws
 * rather than running zero jobs and reporting success — a typo in a schedule
 * would otherwise look like a healthy run forever.
 */
export function selectJobs(jobs: readonly CronJob[], selector?: string): CronJob[] {
  if (selector === undefined) return [...jobs]

  const selected = selector.includes(JOB_NAME_SEPARATOR)
    ? jobs.filter((job) => job.name === selector)
    : jobs.filter((job) => job.name.startsWith(`${selector}${JOB_NAME_SEPARATOR}`))

  if (selected.length === 0) {
    const modules = [...new Set(jobs.map((job) => job.name.split(JOB_NAME_SEPARATOR)[0]))]
    const known = [...modules, ...jobs.map((job) => job.name)].join(', ')
    throw new CronInvocationError(
      `${UNKNOWN_TARGET} "${selector}" — known targets: ${known}`,
    )
  }

  return selected
}

/**
 * Runs each job in order, isolating failures: a job that throws is recorded and
 * the next still runs. Split from `runCron` so the loop is unit-testable with no
 * database. Serial and not parallel — a one-shot has no deadline, and serial
 * keeps database load predictable and the log readable.
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
 * Builds the framework-free graph, runs the selected cron jobs,
 * and closes the pool. Does not log or call `process.exit` — `cron.ts` owns
 * both, so this stays a function returning data.
 *
 * `selectJobs` runs after the container is built, not before: the container is
 * the single source of truth for which targets exist, and a typo paying for one
 * pool open is cheaper than a second list to keep in sync.
 */
export async function runCron(
  env: Env,
  logger: AppLogger,
  selector?: string,
): Promise<JobOutcome[]> {
  const { db, pool } = createDatabase(env)
  try {
    const container = makeContainer(db, env, logger)
    const jobs = qualify(AUTH_MODULE, container.auth.jobs)
    return await runJobs(selectJobs(jobs, selector))
  } finally {
    await pool.end()
  }
}

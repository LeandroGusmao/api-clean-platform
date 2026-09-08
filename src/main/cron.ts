import { env } from '#infra/config/env'
import { createLogger } from '#infra/observability/logger'
import {
  CRON_EXIT_BAD_INVOCATION,
  CRON_EXIT_JOB_FAILED,
  CronInvocationError,
  cronExitCode,
  type JobOutcome,
  jobArgFrom,
  runCron,
} from './run-cron.js'

const CRON_JOB_DONE = 'cron job done'
const CRON_JOB_FAILED = 'cron job failed'
const CRON_RUN_COMPLETE = 'cron run complete'
const CRON_RUN_ABORTED = 'cron run aborted'

const logger = createLogger(env)

let selector: string | undefined
let outcomes: JobOutcome[]

/**
 * A bad target, or a graph that cannot be built at all, ends here rather than as
 * an unhandled rejection: the operator gets one line naming the problem instead
 * of a stack. The two are told apart by the exit code — only the command line
 * being wrong earns `CRON_EXIT_BAD_INVOCATION`.
 */
try {
  selector = jobArgFrom(process.argv)
  outcomes = await runCron(env, logger, selector)
} catch (error) {
  logger.error({ err: error, selector }, CRON_RUN_ABORTED)
  process.exit(
    error instanceof CronInvocationError
      ? CRON_EXIT_BAD_INVOCATION
      : CRON_EXIT_JOB_FAILED,
  )
}

for (const outcome of outcomes) {
  if (outcome.error !== undefined) {
    logger.error(
      { job: outcome.name, durationMs: outcome.durationMs, err: outcome.error },
      CRON_JOB_FAILED,
    )
  } else {
    logger.info(
      { job: outcome.name, durationMs: outcome.durationMs, ...outcome.metrics },
      CRON_JOB_DONE,
    )
  }
}

const exitCode = cronExitCode(outcomes)
logger.info({ jobs: outcomes.length, selector, exitCode }, CRON_RUN_COMPLETE)
process.exit(exitCode)

import { env } from '#infra/config/env'
import { createLogger } from '#infra/observability/logger'
import { cronExitCode, runCron } from './run-cron.js'

const CRON_JOB_DONE = 'cron job done'
const CRON_JOB_FAILED = 'cron job failed'
const CRON_RUN_COMPLETE = 'cron run complete'

const logger = createLogger(env)
const outcomes = await runCron(env, logger)

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
logger.info({ jobs: outcomes.length, exitCode }, CRON_RUN_COMPLETE)
process.exit(exitCode)

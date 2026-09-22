import { env } from '#infra/config/env'
import { createLogger } from '#infra/observability/logger'
import { SEED_EXIT_OK, seedExitCodeFor } from '#main/seeds/runner'
import { runReset } from './runner.js'

const RESET_RUN_COMPLETE = 'reset run complete'
const RESET_RUN_ABORTED = 'reset run aborted'

const logger = createLogger(env)

try {
  const scenarios = await runReset(env, logger)
  logger.info({ scenarios }, RESET_RUN_COMPLETE)
  process.exit(SEED_EXIT_OK)
} catch (error) {
  logger.error({ err: error }, RESET_RUN_ABORTED)
  process.exit(seedExitCodeFor(error))
}

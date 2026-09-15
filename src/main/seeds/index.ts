import { env } from '#infra/config/env'
import { createLogger } from '#infra/observability/logger'
import {
  formatScenarioList,
  LIST_FLAG,
  qualifyScenarios,
  runSeed,
  SEED_EXIT_OK,
  SEED_MODULES,
  seedExitCodeFor,
} from './runner.js'

/** `process.argv` is `[node, script, ...args]`. */
const FIRST_ARG_INDEX = 2
const LINE_BREAK = '\n'

const SEED_RUN_COMPLETE = 'seed run complete'
const SEED_RUN_ABORTED = 'seed run aborted'

const logger = createLogger(env)
const args = process.argv.slice(FIRST_ARG_INDEX)

// Listing is output for a human, not an event: stdout, not the logger.
if (args.includes(LIST_FLAG)) {
  const lines = formatScenarioList(qualifyScenarios(SEED_MODULES))
  process.stdout.write(`${lines.join(LINE_BREAK)}${LINE_BREAK}`)
  process.exit(SEED_EXIT_OK)
}

try {
  const scenarios = await runSeed(env, logger, args)
  logger.info({ scenarios }, SEED_RUN_COMPLETE)
  process.exit(SEED_EXIT_OK)
} catch (error) {
  logger.error({ err: error, args }, SEED_RUN_ABORTED)
  process.exit(seedExitCodeFor(error))
}

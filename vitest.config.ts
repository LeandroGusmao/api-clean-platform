import { defineConfig } from 'vitest/config'
import { TEST_DATABASE_URL } from './tests/integration/setup/test-database-url.js'

const UNIT_PROJECT = 'unit'
const UNIT_INCLUDE = 'src/**/*.spec.ts'

const INTEGRATION_PROJECT = 'integration'
const INTEGRATION_INCLUDE = 'tests/integration/**/*.spec.ts'
const INTEGRATION_GLOBAL_SETUP = './tests/integration/setup/migrate-test-database.ts'

const NODE_ENV_TEST = 'test'

/**
 * No `resolve.conditions` here on purpose: Vite already asks for the
 * `development` condition in test mode, so `#infra/*` resolves to `src/` and
 * never to the compiled `dist/`. Verified by loading a sentinel planted in
 * `dist/` and watching the sources win. Overriding the array would replace
 * Vite's defaults and create the very hazard it would be guarding against.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: UNIT_PROJECT,
          include: [UNIT_INCLUDE],
        },
      },
      {
        test: {
          name: INTEGRATION_PROJECT,
          include: [INTEGRATION_INCLUDE],
          // Migrations run before the suite: the test database is tmpfs, so it
          // is empty after every container restart.
          globalSetup: [INTEGRATION_GLOBAL_SETUP],
          // Every integration file shares the same Postgres, so they run
          // serially — parallel files would step on each other's state.
          fileParallelism: false,
        },
      },
    ],
    // Injected here so no test ever touches `process.env` — R6 stays intact
    // and `biome.jsonc` needs no test-only exception.
    env: {
      NODE_ENV: NODE_ENV_TEST,
      DATABASE_URL: TEST_DATABASE_URL,
    },
  },
})

import { defineConfig } from 'vitest/config'
import { TEST_DATABASE_URL } from './tests/integration/setup/test-database-url.js'
import { TEST_REDIS_URL } from './tests/integration/setup/test-redis-url.js'

const UNIT_PROJECT = 'unit'
const UNIT_INCLUDE = ['src/**/*.spec.ts', 'tools/**/*.spec.mjs']

const INTEGRATION_PROJECT = 'integration'
const INTEGRATION_INCLUDE = 'tests/integration/**/*.spec.ts'
const INTEGRATION_GLOBAL_SETUP = './tests/integration/setup/migrate-test-database.ts'
const INTEGRATION_SETUP_FILE = './tests/integration/setup/flush-redis-before-file.ts'

const NODE_ENV_TEST = 'test'
const TEST_JWT_SECRET = 'an-integration-test-secret-32-chars'
const TEST_GOOGLE_CLIENT_ID = 'integration-test-google-client-id'
const TEST_JWT_ISSUER = 'api-clean-platform-test'
const TEST_JWT_AUDIENCE = 'api-clean-platform-test'

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
          include: UNIT_INCLUDE,
        },
      },
      {
        test: {
          name: INTEGRATION_PROJECT,
          include: [INTEGRATION_INCLUDE],
          // Migrations run before the suite: the test database is tmpfs, so it
          // is empty after every container restart.
          globalSetup: [INTEGRATION_GLOBAL_SETUP],
          setupFiles: [INTEGRATION_SETUP_FILE],
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
      REDIS_URL: TEST_REDIS_URL,
      // Not configuration: a test fixture, like TEST_DATABASE_URL. `env.ts`
      // exits the process on an invalid environment, so without this the whole
      // integration project fails to boot rather than failing a test.
      JWT_SECRET: TEST_JWT_SECRET,
      // Same story: required with no default, so the integration
      // project cannot boot without it.
      GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
      // Required with no default for the same reason as JWT_SECRET above: they
      // carry no default precisely so two deployments cannot share one.
      JWT_ISSUER: TEST_JWT_ISSUER,
      JWT_AUDIENCE: TEST_JWT_AUDIENCE,
    },
  },
})

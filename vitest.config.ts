import { defineConfig } from 'vitest/config'

const UNIT_PROJECT = 'unit'
const UNIT_INCLUDE = 'src/**/*.spec.ts'

const INTEGRATION_PROJECT = 'integration'
const INTEGRATION_INCLUDE = 'tests/integration/**/*.spec.ts'

const NODE_ENV_TEST = 'test'
const TEST_DATABASE_URL =
  'postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5433/api_clean_platform_test'

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
          // Every integration file shares the same Postgres, so they run
          // serially — parallel files would step on each other's state.
          fileParallelism: false,
        },
      },
    ],
    // Injected here so no test ever touches `process.env` — R6 stays intact
    // and `biome.json` needs no test-only exception.
    env: {
      NODE_ENV: NODE_ENV_TEST,
      DATABASE_URL: TEST_DATABASE_URL,
    },
  },
})

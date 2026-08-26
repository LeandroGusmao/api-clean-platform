/**
 * The one place this URL is written outside CI. `vitest.config.ts` injects it as
 * `DATABASE_URL` for the tests, and the global setup connects with it to apply
 * migrations.
 *
 * **Hardcoded on purpose — do not move this to `.env`.** It reads like
 * configuration and is not: this is a test fixture, the other half of the
 * `postgres-test` service in `docker-compose.yml`, which already commits these
 * exact credentials and pins port 5433. The application's own `DATABASE_URL`
 * does come from the environment, validated in `src/infra/config/env.ts`.
 *
 * Four reasons it stays here, the first being the one that decides it:
 *
 * 1. The integration suite is destructive — specs delete rows to isolate
 *    themselves. `.env` is gitignored and per-machine, so a value pointing at
 *    the development database (same credentials, neighbouring port) would wipe
 *    it, and nobody would see it in review. A wrong value in this file is a
 *    line in a diff.
 * 2. Only `src/infra/config/env.ts` reads `process.env` (R6). Keeping this a
 *    constant is what lets that rule hold with no exception in `biome.jsonc`.
 * 3. The global setup runs in Vitest's main process, which `test.env` does not
 *    reach — so it could not read an injected value anyway, and nothing here
 *    loads a `.env` file.
 * 4. `.env` is gitignored, so a fresh clone has none. This keeps
 *    `pnpm install && pnpm test:integration` working with no setup step.
 *
 * If a real need to point the suite elsewhere ever appears, the shape is an
 * env override plus a guard rejecting any database name not ending in `_test` —
 * never a bare override.
 *
 * `.github/workflows/ci.yml` deliberately keeps its own copy: the Postgres
 * service container is configured before any of this code could be read.
 */
export const TEST_DATABASE_URL =
  'postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5433/api_clean_platform_test'

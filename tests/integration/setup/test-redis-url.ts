/**
 * The other half of the `redis-test` service in `docker-compose.yml`, pinned to
 * its port. `vitest.config.ts` injects it as `REDIS_URL` for the integration
 * suite, for the reasons `test-database-url.ts` gives for `DATABASE_URL`: a
 * fixture and not configuration, so a `.env` pointing at the development Redis
 * can never be flushed by a spec.
 *
 * `.github/workflows/ci.yml` keeps its own copy: the service container is
 * configured before any of this code could be read.
 */
export const TEST_REDIS_URL = 'redis://127.0.0.1:6380'

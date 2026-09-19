/**
 * `@fastify/rate-limit` ships no types for its in-process counter and does not
 * export it, so the deep path is declared here. The package version is pinned
 * exactly; a bump that moves the file fails `scoped-rate-limit-store.ts` at
 * import time, in the unit suite.
 */
declare module '@fastify/rate-limit/store/LocalStore.js' {
  import type { FastifyRateLimitStore } from '@fastify/rate-limit'

  const LocalStore: new (
    continueExceeding: boolean,
    exponentialBackoff: boolean,
    cache?: number,
  ) => FastifyRateLimitStore

  export = LocalStore
}

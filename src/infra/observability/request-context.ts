import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestContext {
  traceId: string
}

/**
 * Ambient per-request context. It exists so the traceId reaches the logger and
 * the error handler without being threaded through every signature — a `ctx`
 * parameter is viral and forgetting to pass it breaks correlation silently.
 *
 * This is the only implicit-context point in the project, and it is deliberately
 * isolated here: migrating to OpenTelemetry later replaces this file alone, with
 * `getTraceId` reading from the active span instead.
 */
const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn)
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId
}

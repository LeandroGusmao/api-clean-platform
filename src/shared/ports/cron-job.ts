/**
 * A unit of scheduled maintenance a module publishes for the `cron.ts`
 * entrypoint to run. The runner does not read `run`'s result shape — it merges
 * the object into the run-log line — so a prune job returns `{ rowsDeleted }`
 * and a future outbox-dispatch job returns its own counters.
 */
export interface CronJob {
  /** Stable identifier the scheduler and the run log key on. kebab-case. */
  readonly name: string
  run(): Promise<Record<string, number>>
}

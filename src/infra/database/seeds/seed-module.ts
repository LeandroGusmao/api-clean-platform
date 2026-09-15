import type { Database } from '#infra/database/client'

/**
 * What a module publishes for `pnpm db:seed`. Lives in global infra rather than
 * in `main/` because a module's `infra/` may import `#infra/*` and never
 * `#main/*`. It is never part of a container: development data stays out of the
 * graph production builds.
 *
 * `prepare` and `run` use METHOD syntax on purpose. TypeScript checks methods
 * bivariantly, which is what lets a `SeedModule<{ passwordHash: string }>` sit
 * in a `readonly SeedModule[]`; as function-typed properties that assignment
 * would not compile. The runner only ever hands a module's own preparation to
 * that module's scenarios, so the looser check admits no wrong type.
 */
export interface SeedModule<TPreparation = unknown> {
  /** Prefix of its scenarios on the command line: `auth` → `auth:base-users`. */
  readonly name: string
  readonly scenarios: readonly SeedScenario<TPreparation>[]
  /** Runs BEFORE the transaction opens — CPU-heavy work such as argon2 belongs here. */
  prepare(): Promise<TPreparation>
  /** Deletes this module's seed namespace and nothing else. Runs inside the transaction. */
  wipe(tx: Database): Promise<void>
}

export interface SeedScenario<TPreparation = unknown> {
  /** kebab-case and unqualified; the runner adds the module prefix. */
  readonly name: string
  /** One line, shown by `--list`. */
  readonly description: string
  /** Selected when `pnpm db:seed` runs with no target. */
  readonly byDefault?: boolean
  /** Qualified names, so a scenario may depend on another module's: `auth:base-users`. */
  readonly dependsOn?: readonly string[]
  run(ctx: SeedRunContext<TPreparation>): Promise<void>
}

export interface SeedRunContext<TPreparation = unknown> {
  readonly tx: Database
  /** One instant for the whole run, so every row a run writes shares it. */
  readonly now: Date
  /** What this scenario's own module returned from `prepare`. */
  readonly preparation: TPreparation
  /** Tagged with the qualified scenario name. Never pass a credential. */
  log(message: string): void
}

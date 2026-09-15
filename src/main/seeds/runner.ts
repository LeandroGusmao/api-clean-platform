import { type Env, NODE_ENV_PRODUCTION } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import type { SeedModule, SeedScenario } from '#infra/database/seeds/seed-module'
import { createTransactionRunner } from '#infra/database/transaction-runner'
import type { WarnLogger } from '#infra/observability/logger'
import { SystemClock } from '#infra/providers/system-clock'
import { authSeedModule } from '#modules/auth/infra/seeds/index'

export const SEED_EXIT_OK = 0
/** The run started and failed: database, target guard, a scenario that threw, a broken `dependsOn`. */
export const SEED_EXIT_FAILED = 1
/**
 * The command line named a scenario or module that does not exist. Distinct from
 * `SEED_EXIT_FAILED` for the same reason as in `run-cron.ts`: a typo is not a
 * broken seed.
 */
export const SEED_EXIT_BAD_INVOCATION = 2

/**
 * Every module that publishes seed scenarios. Listed by hand, like `AUTH_MODULE`
 * in `run-cron.ts`: a module missed here silently has no seed, so the line has
 * to show up in a diff.
 */
export const SEED_MODULES: readonly SeedModule[] = [authSeedModule]

/**
 * The two levels a run uses, declared as a shape for the reason `WarnLogger`
 * gives: pino's overloads rule out a hand-written double of `AppLogger`.
 */
export interface SeedLogger extends WarnLogger {
  info(details: Record<string, unknown>, message: string): void
}

/** `auth:base-users` — the same format the cron targets use. */
export const SCENARIO_NAME_SEPARATOR = ':'
export const ALL_FLAG = '--all'
export const LIST_FLAG = '--list'
const FLAG_PREFIX = '--'

/** Hostnames as `URL` reports them — IPv6 keeps its brackets. */
const LOCAL_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
])

const PRODUCTION_REFUSAL = 'refusing to seed with NODE_ENV=production'
const REMOTE_HOST_REFUSAL = 'refusing to seed a database outside this machine'
const UNKNOWN_TARGET = 'unknown seed target'
const UNKNOWN_FLAG = 'unknown seed flag'
const NOTHING_SELECTED = 'no seed scenario selected: pass a target or --all'
const UNKNOWN_DEPENDENCY = 'unknown seed scenario'
const DEPENDENCY_CYCLE = 'seed dependency cycle'
const LIST_SEPARATOR = ', '
const DESCRIPTION_SEPARATOR = ' — '
const DEFAULT_MARKER = ' (default)'
const DEPENDS_ON_LABEL = ' — depends on: '
const NO_TEXT = ''

const SEED_INVOCATION_ERROR_NAME = 'SeedInvocationError'
const SEED_DEFINITION_ERROR_NAME = 'SeedDefinitionError'
const SEED_TARGET_ERROR_NAME = 'SeedTargetError'

// Not `AppError`s: none of these reaches HTTP or carries a client-facing `code`.

/** The command line asked for something that does not exist. */
export class SeedInvocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = SEED_INVOCATION_ERROR_NAME
  }
}

/** A scenario's own declaration is broken: a cycle, or a `dependsOn` naming nothing. */
export class SeedDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = SEED_DEFINITION_ERROR_NAME
  }
}

/** The database this run points at is not one the seed may write to (design §7). */
export class SeedTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = SEED_TARGET_ERROR_NAME
  }
}

export interface QualifiedScenario {
  /** `module:scenario`. */
  readonly name: string
  readonly seedModule: SeedModule
  readonly scenario: SeedScenario
}

/**
 * Prefixes each scenario with its module HERE, where the lists meet, rather
 * than trusting each module to name its own — same reasoning as `qualify` in
 * `run-cron.ts`.
 */
export function qualifyScenarios(modules: readonly SeedModule[]): QualifiedScenario[] {
  return modules.flatMap((seedModule) =>
    seedModule.scenarios.map((scenario) => ({
      name: `${seedModule.name}${SCENARIO_NAME_SEPARATOR}${scenario.name}`,
      seedModule,
      scenario,
    })),
  )
}

/**
 * No target runs the defaults; `--all` runs everything; a bare module name runs
 * that module; a qualified name runs one scenario. Anything that matches
 * nothing throws rather than seeding nothing and reporting success.
 */
export function selectScenarios(
  all: readonly QualifiedScenario[],
  args: readonly string[],
): QualifiedScenario[] {
  const flags = args.filter((arg) => arg.startsWith(FLAG_PREFIX))
  const unknownFlag = flags.find((flag) => flag !== ALL_FLAG)
  if (unknownFlag !== undefined) {
    throw new SeedInvocationError(`${UNKNOWN_FLAG} "${unknownFlag}"`)
  }

  if (flags.includes(ALL_FLAG)) return [...all]

  const targets = args.filter((arg) => !arg.startsWith(FLAG_PREFIX))
  const selected =
    targets.length === 0
      ? all.filter((entry) => entry.scenario.byDefault === true)
      : targets.flatMap((target) => matchTarget(all, target))

  if (selected.length === 0) throw new SeedInvocationError(NOTHING_SELECTED)
  return selected
}

function matchTarget(
  all: readonly QualifiedScenario[],
  target: string,
): QualifiedScenario[] {
  const matched = target.includes(SCENARIO_NAME_SEPARATOR)
    ? all.filter((entry) => entry.name === target)
    : all.filter((entry) => entry.seedModule.name === target)

  if (matched.length === 0) {
    const modules = [...new Set(all.map((entry) => entry.seedModule.name))]
    const known = [...modules, ...all.map((entry) => entry.name)].join(LIST_SEPARATOR)
    throw new SeedInvocationError(
      `${UNKNOWN_TARGET} "${target}" — known targets: ${known}`,
    )
  }
  return matched
}

/** Depth-first topological order: every dependency lands before its dependent, each scenario once. */
export function resolveOrder(
  all: readonly QualifiedScenario[],
  requested: readonly QualifiedScenario[],
): QualifiedScenario[] {
  const byName = new Map(all.map((entry) => [entry.name, entry]))
  const ordered: QualifiedScenario[] = []
  const settled = new Set<string>()
  const visiting = new Set<string>()

  const visit = (entry: QualifiedScenario): void => {
    if (settled.has(entry.name)) return
    if (visiting.has(entry.name)) {
      throw new SeedDefinitionError(`${DEPENDENCY_CYCLE} at "${entry.name}"`)
    }

    visiting.add(entry.name)
    for (const dependencyName of entry.scenario.dependsOn ?? []) {
      const dependency = byName.get(dependencyName)
      if (dependency === undefined) {
        throw new SeedDefinitionError(
          `${UNKNOWN_DEPENDENCY} "${dependencyName}" in dependsOn of "${entry.name}"`,
        )
      }
      visit(dependency)
    }
    visiting.delete(entry.name)

    settled.add(entry.name)
    ordered.push(entry)
  }

  for (const entry of requested) visit(entry)
  return ordered
}

/**
 * Two guards, and no flag to bypass either (design §7). The second exists
 * because `NODE_ENV` defaults to development: a server shell without it would
 * pass the first and plant an account with a published password.
 *
 * The refusal names the host only — the URL carries the credentials.
 */
export function assertSeedTarget(target: Pick<Env, 'NODE_ENV' | 'DATABASE_URL'>): void {
  if (target.NODE_ENV === NODE_ENV_PRODUCTION) {
    throw new SeedTargetError(PRODUCTION_REFUSAL)
  }

  const { hostname } = new URL(target.DATABASE_URL)
  if (!LOCAL_DATABASE_HOSTS.has(hostname)) {
    throw new SeedTargetError(`${REMOTE_HOST_REFUSAL}: "${hostname}"`)
  }
}

export function seedExitCodeFor(error: unknown): number {
  return error instanceof SeedInvocationError
    ? SEED_EXIT_BAD_INVOCATION
    : SEED_EXIT_FAILED
}

export function formatScenarioList(all: readonly QualifiedScenario[]): string[] {
  return all.map(({ name, scenario }) => {
    const marker = scenario.byDefault === true ? DEFAULT_MARKER : NO_TEXT
    const dependsOn =
      scenario.dependsOn !== undefined && scenario.dependsOn.length > 0
        ? `${DEPENDS_ON_LABEL}${scenario.dependsOn.join(LIST_SEPARATOR)}`
        : NO_TEXT
    return `${name}${marker}${DESCRIPTION_SEPARATOR}${scenario.description}${dependsOn}`
  })
}

/**
 * Guards the target, resolves what to run, then wipes and seeds in ONE
 * transaction: a scenario that throws leaves the database as it was. Returns
 * the qualified names that ran, in order. Does not exit the process — the CLI
 * shell owns that, so this stays a function returning data.
 *
 * `modules` is a parameter so the integration suite can inject modules that
 * fail; production callers take the default.
 */
export async function runSeed(
  env: Env,
  logger: SeedLogger,
  args: readonly string[],
  modules: readonly SeedModule[] = SEED_MODULES,
): Promise<string[]> {
  assertSeedTarget(env)

  const all = qualifyScenarios(modules)
  // Before any connection: a typo or a broken `dependsOn` costs no pool.
  const order = resolveOrder(all, selectScenarios(all, args))

  // Outside the transaction (design §5.1): argon2 must not run inside one.
  const preparations = new Map<SeedModule, unknown>()
  for (const seedModule of modules) {
    preparations.set(seedModule, await seedModule.prepare())
  }

  const now = new SystemClock().now()
  const { db, pool } = createDatabase(env)
  try {
    const transaction = createTransactionRunner(db, logger)
    await transaction(async (tx) => {
      // Every module, not only the selected ones, and in reverse: there is no
      // foreign key between modules, so no cascade clears one for another.
      for (const seedModule of [...modules].reverse()) {
        await seedModule.wipe(tx)
      }
      for (const entry of order) {
        await entry.scenario.run({
          tx,
          now,
          preparation: preparations.get(entry.seedModule),
          log: (message) => logger.info({ scenario: entry.name }, message),
        })
      }
    })
    return order.map((entry) => entry.name)
  } finally {
    await pool.end()
  }
}

# Dev Database Seed Implementation Plan

> **Emendado na execução:** não existe `infra/seeds/constants.ts`. Cada constante
> mora no arquivo que a usa (`SEED_EMAIL_DOMAIN` em `factories.ts`,
> `SEED_PASSWORD` em `index.ts`, e-mails e código nos arquivos de cenário). A
> Task 3 abaixo descreve o layout planejado; a spec §4 e §5.2 refletem o final.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm db:seed` brings the local development database to a known, reproducible state through per-module seed scenarios, plus the `db:*` scripts the byteflow project has and this one lacks.

**Architecture:** A seed contract in global infra (`src/infra/database/seeds/`), scenarios published by each module under its own `infra/seeds/`, and a runner in the composition root (`src/main/seeds/`) that guards the target, resolves `dependsOn`, runs every module's `prepare()` outside the transaction, then wipes every module's seed namespace and runs the selected scenarios inside ONE transaction. Scenarios write through domain entities and the Drizzle repositories; only the wipe is raw SQL. Nothing seed-related enters a container or the `dist/` build.

**Tech Stack:** Node 24 · TypeScript 7 ESM · Drizzle `1.0.0-rc.4` · PostgreSQL 18 · Vitest 4 · Biome 2 · pnpm 11 · tsx

**Spec:** `docs/superpowers/specs/2026-09-14-dev-database-seed-design.md`

## Global Constraints

- All code, identifiers, strings, log and error messages, and comments in **English**. Markdown docs may be Portuguese.
- **No magic strings or numbers** inline: extract to named `UPPER_SNAKE_CASE` constants near their use (`CLAUDE.md`). Test files follow the same convention as `tests/integration/login.spec.ts`: wire-contract values spelled out as local constants.
- **Comments explain the code, never the process** — no "slice 15", no "the review found". Cite the spec by section (`design §7`) instead of re-arguing it.
- **R6:** nothing reads `process.env` outside `src/infra/config/env.ts`. The seed reads `env` from `#infra/config/env`.
- **Imports:** subpath `#infra/*`, `#modules/*`, `#main/*`, `#shared/*` across folders; relative imports end in `.js`.
- **No new dependency.** Every package used here is already in `package.json`.
- **Boundary table** (`.claude/skills/architecture-audit/references/checks.md`): `src/infra/**` never imports `#modules/*` or `#main/*`; `src/modules/auth/infra/**` imports only `auth`'s own pure + infra and `#infra/*`; `src/main/**` imports anything.
- **The seed password never reaches a log line** (design §3.4). Log e-mails only.
- **Target guards, no override flag** (design §7): refuse `NODE_ENV=production`; refuse any `DATABASE_URL` hostname other than `localhost`, `127.0.0.1`, `[::1]` (the form `URL` reports for IPv6).
- **Running `pnpm`:** the shell's default node may be older than `engines`. Prefix every session with
  `export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"`.
- **Never pipe a gate** (`pnpm lint | tail` hides the exit code). Run each gate on its own.
- **Integration tests need the containers:** `docker compose up -d --wait` before `pnpm test:integration`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Map

| File | Responsibility | Task |
|---|---|---|
| `src/infra/config/env.ts` | export `NODE_ENV_PRODUCTION` (today module-private) | 1 |
| `src/infra/database/seeds/seed-module.ts` | the contract: `SeedModule`, `SeedScenario`, `SeedRunContext` | 1 |
| `src/main/seeds/runner.ts` | pure selection/order/guard functions (T1), `runSeed` + `SEED_MODULES` (T2, T3) | 1–3 |
| `src/main/seeds/runner.spec.ts` | unit tests of the pure functions | 1 |
| `tsconfig.build.json` | exclude `**/seeds/**` from `dist/` | 1 |
| `tests/integration/seed-runner.spec.ts` | `runSeed` against Postgres with fake modules | 2 |
| `src/modules/auth/infra/seeds/constants.ts` | seed e-mails, password, code, TTL, names | 3 |
| `src/modules/auth/infra/seeds/factories.ts` | `AuthSeedPreparation`, entity+repository writes, `wipeAuthSeedNamespace` | 3 |
| `src/modules/auth/infra/seeds/base-users.ts` | scenario `auth:base-users` | 3 |
| `src/modules/auth/infra/seeds/pending-registration.ts` | scenario `auth:pending-registration` | 3 |
| `src/modules/auth/infra/seeds/index.ts` | `authSeedModule` | 3 |
| `tests/integration/seed.spec.ts` | the `auth` seed end to end (login, confirm, re-run) | 3 |
| `src/main/seeds/index.ts` | CLI shell: argv, `--list`, log, exit code | 4 |
| `package.json` | `db:up`, `db:down`, `db:logs`, `db:studio`, `db:seed`; `.env` for drizzle-kit | 4 |
| `ARCHITECTURE.md`, `docs/DECISIONS.md`, `src/modules/auth/README.md`, `docs/TODO.md` | documentation | 5 |

---

### Task 1: Seed contract and the runner's pure functions

**Files:**
- Modify: `src/infra/config/env.ts` (the line `const NODE_ENV_PRODUCTION = 'production'`)
- Create: `src/infra/database/seeds/seed-module.ts`
- Create: `src/main/seeds/runner.ts`
- Test: `src/main/seeds/runner.spec.ts`
- Modify: `tsconfig.build.json`

**Interfaces:**
- Consumes: `Env` and `NODE_ENV_PRODUCTION` from `#infra/config/env`; `Database` from `#infra/database/client`.
- Produces:
  - `SeedModule<TPreparation = unknown>` `{ readonly name: string; readonly scenarios: readonly SeedScenario<TPreparation>[]; prepare(): Promise<TPreparation>; wipe(tx: Database): Promise<void> }`
  - `SeedScenario<TPreparation = unknown>` `{ readonly name: string; readonly description: string; readonly byDefault?: boolean; readonly dependsOn?: readonly string[]; run(ctx: SeedRunContext<TPreparation>): Promise<void> }`
  - `SeedRunContext<TPreparation = unknown>` `{ readonly tx: Database; readonly now: Date; readonly preparation: TPreparation; log(message: string): void }`
  - From `runner.ts`: `SEED_EXIT_OK`, `SEED_EXIT_FAILED`, `SEED_EXIT_BAD_INVOCATION`, `SCENARIO_NAME_SEPARATOR`, `ALL_FLAG`, `LIST_FLAG`, `QualifiedScenario { name; seedModule; scenario }`, `SeedInvocationError`, `SeedDefinitionError`, `SeedTargetError`, `qualifyScenarios(modules)`, `selectScenarios(all, args)`, `resolveOrder(all, requested)`, `assertSeedTarget(target)`, `seedExitCodeFor(error)`, `formatScenarioList(all)`.

- [ ] **Step 1: Export the production constant from `env.ts`**

In `src/infra/config/env.ts`, change

```ts
const NODE_ENV_PRODUCTION = 'production'
```

to

```ts
export const NODE_ENV_PRODUCTION = 'production'
```

- [ ] **Step 2: Create the contract**

Create `src/infra/database/seeds/seed-module.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing unit tests**

Create `src/main/seeds/runner.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { SeedModule, SeedScenario } from '#infra/database/seeds/seed-module'
import {
  ALL_FLAG,
  assertSeedTarget,
  formatScenarioList,
  qualifyScenarios,
  resolveOrder,
  SEED_EXIT_BAD_INVOCATION,
  SEED_EXIT_FAILED,
  SeedDefinitionError,
  SeedInvocationError,
  SeedTargetError,
  seedExitCodeFor,
  selectScenarios,
} from './runner.js'

const LOCALHOST_URL = 'postgres://user:pass@localhost:5432/app'
const LOOPBACK_V4_URL = 'postgres://user:pass@127.0.0.1:5433/app_test'
const LOOPBACK_V6_URL = 'postgres://user:pass@[::1]:5432/app'
const REMOTE_URL = 'postgres://user:pass@db.example.com:5432/app'
const DEVELOPMENT = 'development'
const TEST = 'test'
const PRODUCTION = 'production'

const scenario = (name: string, extra: Partial<SeedScenario> = {}): SeedScenario => ({
  name,
  description: `${name} description`,
  run: async () => {},
  ...extra,
})

const seedModule = (name: string, scenarios: SeedScenario[]): SeedModule => ({
  name,
  scenarios,
  prepare: async () => undefined,
  wipe: async () => {},
})

const AUTH = seedModule('auth', [
  scenario('base-users', { byDefault: true }),
  scenario('pending', { dependsOn: ['auth:base-users'] }),
])
const BILLING = seedModule('billing', [
  scenario('invoices', { dependsOn: ['auth:pending'] }),
])
const ALL = qualifyScenarios([AUTH, BILLING])

const names = (entries: readonly { name: string }[]) => entries.map((entry) => entry.name)

describe('qualifyScenarios', () => {
  it('prefixes every scenario with its module and keeps the module reference', () => {
    expect(names(ALL)).toEqual(['auth:base-users', 'auth:pending', 'billing:invoices'])
    expect(ALL[0]?.seedModule).toBe(AUTH)
    expect(ALL[2]?.seedModule).toBe(BILLING)
  })
})

describe('selectScenarios', () => {
  it('selects the default scenarios when no target is given', () => {
    expect(names(selectScenarios(ALL, []))).toEqual(['auth:base-users'])
  })

  it('selects everything with --all', () => {
    expect(names(selectScenarios(ALL, [ALL_FLAG]))).toEqual(names(ALL))
  })

  it('selects a whole module by its bare name', () => {
    expect(names(selectScenarios(ALL, ['auth']))).toEqual(['auth:base-users', 'auth:pending'])
  })

  it('selects one scenario by its qualified name', () => {
    expect(names(selectScenarios(ALL, ['billing:invoices']))).toEqual(['billing:invoices'])
  })

  it('rejects an unknown qualified name, listing the known targets', () => {
    expect(() => selectScenarios(ALL, ['auth:nope'])).toThrow(SeedInvocationError)
    expect(() => selectScenarios(ALL, ['auth:nope'])).toThrow(/auth:base-users/)
  })

  it('rejects an unknown module name', () => {
    expect(() => selectScenarios(ALL, ['nope'])).toThrow(SeedInvocationError)
  })

  it('rejects an unknown flag', () => {
    expect(() => selectScenarios(ALL, ['--bogus'])).toThrow(SeedInvocationError)
  })

  it('rejects a run that selects nothing', () => {
    const noDefaults = qualifyScenarios([seedModule('solo', [scenario('only')])])

    expect(() => selectScenarios(noDefaults, [])).toThrow(SeedInvocationError)
  })
})

describe('resolveOrder', () => {
  it('puts transitive dependencies before the scenario that needs them', () => {
    const requested = selectScenarios(ALL, ['billing:invoices'])

    expect(names(resolveOrder(ALL, requested))).toEqual([
      'auth:base-users',
      'auth:pending',
      'billing:invoices',
    ])
  })

  it('runs a scenario requested twice only once', () => {
    const requested = selectScenarios(ALL, ['auth:pending', 'auth'])

    expect(names(resolveOrder(ALL, requested))).toEqual(['auth:base-users', 'auth:pending'])
  })

  it('rejects a dependency cycle', () => {
    const cyclic = qualifyScenarios([
      seedModule('demo', [
        scenario('a', { dependsOn: ['demo:b'] }),
        scenario('b', { dependsOn: ['demo:a'] }),
      ]),
    ])

    expect(() => resolveOrder(cyclic, cyclic)).toThrow(SeedDefinitionError)
  })

  it('rejects an unknown dependsOn, naming the scenario that declared it', () => {
    const broken = qualifyScenarios([
      seedModule('demo', [scenario('x', { dependsOn: ['auth:ghost'] })]),
    ])

    expect(() => resolveOrder(broken, broken)).toThrow(SeedDefinitionError)
    expect(() => resolveOrder(broken, broken)).toThrow(/demo:x/)
  })
})

describe('assertSeedTarget', () => {
  it('refuses production even on a local database', () => {
    expect(() =>
      assertSeedTarget({ NODE_ENV: PRODUCTION, DATABASE_URL: LOCALHOST_URL }),
    ).toThrow(SeedTargetError)
  })

  it('refuses a database outside this machine, naming only the host', () => {
    expect(() =>
      assertSeedTarget({ NODE_ENV: DEVELOPMENT, DATABASE_URL: REMOTE_URL }),
    ).toThrow(/db\.example\.com/)
    expect(() =>
      assertSeedTarget({ NODE_ENV: DEVELOPMENT, DATABASE_URL: REMOTE_URL }),
    ).not.toThrow(/pass/)
  })

  it.each([LOCALHOST_URL, LOOPBACK_V4_URL, LOOPBACK_V6_URL])(
    'accepts the local database %s',
    (url) => {
      expect(() => assertSeedTarget({ NODE_ENV: DEVELOPMENT, DATABASE_URL: url })).not.toThrow()
      expect(() => assertSeedTarget({ NODE_ENV: TEST, DATABASE_URL: url })).not.toThrow()
    },
  )
})

describe('seedExitCodeFor', () => {
  it('separates a bad command line from a failed run', () => {
    expect(seedExitCodeFor(new SeedInvocationError('typo'))).toBe(SEED_EXIT_BAD_INVOCATION)
    expect(seedExitCodeFor(new SeedTargetError('remote'))).toBe(SEED_EXIT_FAILED)
    expect(seedExitCodeFor(new SeedDefinitionError('cycle'))).toBe(SEED_EXIT_FAILED)
    expect(seedExitCodeFor(new Error('database down'))).toBe(SEED_EXIT_FAILED)
  })
})

describe('formatScenarioList', () => {
  it('prints one line per scenario with its default marker and dependencies', () => {
    const lines = formatScenarioList(ALL)

    expect(lines).toHaveLength(ALL.length)
    expect(lines[0]).toContain('auth:base-users')
    expect(lines[0]).toContain('(default)')
    expect(lines[0]).toContain('base-users description')
    expect(lines[1]).not.toContain('(default)')
    expect(lines[1]).toContain('depends on: auth:base-users')
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm test:unit src/main/seeds/runner.spec.ts`
Expected: FAIL — `Failed to load url ./runner.js` (the module does not exist yet).

- [ ] **Step 5: Implement the pure runner functions**

Create `src/main/seeds/runner.ts`:

```ts
import { type Env, NODE_ENV_PRODUCTION } from '#infra/config/env'
import type { SeedModule, SeedScenario } from '#infra/database/seeds/seed-module'

export const SEED_EXIT_OK = 0
/** The run started and failed: database, target guard, a scenario that threw, a broken `dependsOn`. */
export const SEED_EXIT_FAILED = 1
/**
 * The command line named a scenario or module that does not exist. Distinct from
 * `SEED_EXIT_FAILED` for the same reason as in `run-cron.ts`: a typo is not a
 * broken seed.
 */
export const SEED_EXIT_BAD_INVOCATION = 2

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
    throw new SeedInvocationError(`${UNKNOWN_TARGET} "${target}" — known targets: ${known}`)
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
  return error instanceof SeedInvocationError ? SEED_EXIT_BAD_INVOCATION : SEED_EXIT_FAILED
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test:unit src/main/seeds/runner.spec.ts`
Expected: PASS — every test in the file green.

- [ ] **Step 7: Keep seeds out of the build**

In `tsconfig.build.json`, replace the comment paragraph that starts with `` `fixtures/` is excluded `` and the `exclude` line so they read:

```jsonc
  // `fixtures/` and `seeds/` are excluded on the same grounds as `in-memory/`
  // below. `fixtures/` holds test-only data — including a hardcoded JWT secret —
  // and `seeds/` holds development data with a published password; neither has
  // business in a published build. All are globs, not paths, so any module may
  // add either folder and get the exclusion for free.
```

```jsonc
  "exclude": ["**/*.spec.ts", "**/in-memory/**", "**/fixtures/**", "**/seeds/**"]
```

- [ ] **Step 8: Run the static gates**

Run each on its own:
- `pnpm lint` — Expected: no errors. If it reports only import/specifier ordering, run `pnpm lint:fix` and re-run `pnpm lint`.
- `pnpm typecheck` — Expected: exit 0.
- `pnpm test:unit` — Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/infra/config/env.ts src/infra/database/seeds/seed-module.ts src/main/seeds/runner.ts src/main/seeds/runner.spec.ts tsconfig.build.json
git commit -F - <<'EOF'
feat(seed): seed contract and the runner's selection, order and target guard

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: `runSeed` — one transaction against Postgres

**Files:**
- Modify: `src/main/seeds/runner.ts`
- Test: `tests/integration/seed-runner.spec.ts`

**Interfaces:**
- Consumes: everything Task 1 produced; `createDatabase` (`#infra/database/client`), `createTransactionRunner` (`#infra/database/transaction-runner`), `WarnLogger` (`#infra/observability/logger`), `SystemClock` (`#infra/providers/system-clock`).
- Produces:
  - `SEED_MODULES: readonly SeedModule[]` (empty until Task 3)
  - `SeedLogger extends WarnLogger { info(details: Record<string, unknown>, message: string): void }`
  - `runSeed(env: Env, logger: SeedLogger, args: readonly string[], modules?: readonly SeedModule[]): Promise<string[]>` — resolves to the qualified names run, in order.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/seed-runner.spec.ts`:

```ts
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import type { SeedModule } from '#infra/database/seeds/seed-module'
import { runSeed, type SeedLogger, SeedTargetError } from '#main/seeds/runner'
import { users } from '#modules/auth/infra/drizzle/schema/users'

const PRIMARY_DOMAIN = 'runner-primary.local'
const SECONDARY_DOMAIN = 'runner-secondary.local'
const PASSWORD_HASH = 'argon2-irrelevant'
const MARKER = 'prepared'
const SCENARIO_FAILURE = 'scenario blew up'
const REMOTE_DATABASE_URL = 'postgres://user:pass@db.example.com:5432/app'
const LIKE_ANY_PREFIX = '%@'

const PREPARED_EMAIL = `${MARKER}@${PRIMARY_DOMAIN}`
/** Written by `second`, which counts the rows `first` left: 1 proves the order. */
const SECOND_SAW_FIRST_EMAIL = `second-saw-1@${PRIMARY_DOMAIN}`
const STALE_SECONDARY_EMAIL = `stale@${SECONDARY_DOMAIN}`
const HALF_WRITTEN_EMAIL = `half-written@${PRIMARY_DOMAIN}`

const SILENT_LOGGER: SeedLogger = { info: () => {}, warn: () => {} }

interface PrimaryPreparation {
  marker: string
}

let db: Database
let pool: Pool
let wipes: string[]

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  wipes = []
  await db.delete(users)
})

const insertUser = (tx: Database, email: string) =>
  tx.insert(users).values({ email, passwordHash: PASSWORD_HASH })

const deleteDomain = (tx: Database, domain: string) =>
  tx.delete(users).where(sql`lower(${users.email}) like ${`${LIKE_ANY_PREFIX}${domain}`}`)

const primary: SeedModule<PrimaryPreparation> = {
  name: 'primary',
  scenarios: [
    {
      name: 'first',
      description: 'first',
      byDefault: true,
      async run({ tx, preparation }) {
        await insertUser(tx, `${preparation.marker}@${PRIMARY_DOMAIN}`)
      },
    },
    {
      name: 'second',
      description: 'second',
      dependsOn: ['primary:first'],
      async run({ tx }) {
        const firstRows = await tx
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${PREPARED_EMAIL}`)
        await insertUser(tx, `second-saw-${firstRows.length}@${PRIMARY_DOMAIN}`)
      },
    },
  ],
  async prepare() {
    return { marker: MARKER }
  },
  async wipe(tx) {
    wipes.push('primary')
    await deleteDomain(tx, PRIMARY_DOMAIN)
  },
}

const secondary: SeedModule = {
  name: 'secondary',
  scenarios: [{ name: 'only', description: 'only', async run() {} }],
  async prepare() {
    return undefined
  },
  async wipe(tx) {
    wipes.push('secondary')
    await deleteDomain(tx, SECONDARY_DOMAIN)
  },
}

const failing: SeedModule = {
  name: 'failing',
  scenarios: [
    {
      name: 'boom',
      description: 'boom',
      async run({ tx }) {
        await insertUser(tx, HALF_WRITTEN_EMAIL)
        throw new Error(SCENARIO_FAILURE)
      },
    },
  ],
  async prepare() {
    return undefined
  },
  async wipe() {},
}

async function storedEmails(): Promise<string[]> {
  const rows = await db.select({ email: users.email }).from(users)
  return rows.map((row) => row.email).sort()
}

describe('runSeed', () => {
  it('runs dependencies first and hands each scenario its module preparation', async () => {
    const ran = await runSeed(env, SILENT_LOGGER, ['primary:second'], [primary])

    expect(ran).toEqual(['primary:first', 'primary:second'])
    expect(await storedEmails()).toEqual([PREPARED_EMAIL, SECOND_SAW_FIRST_EMAIL])
  })

  it('lands on the same rows when run twice', async () => {
    await runSeed(env, SILENT_LOGGER, [], [primary])
    const afterFirstRun = await storedEmails()
    await runSeed(env, SILENT_LOGGER, [], [primary])

    expect(afterFirstRun).toEqual([PREPARED_EMAIL])
    expect(await storedEmails()).toEqual(afterFirstRun)
  })

  it('wipes every module, in reverse order, even when only one is selected', async () => {
    await insertUser(db, STALE_SECONDARY_EMAIL)

    await runSeed(env, SILENT_LOGGER, ['primary:first'], [primary, secondary])

    expect(wipes).toEqual(['secondary', 'primary'])
    expect(await storedEmails()).toEqual([PREPARED_EMAIL])
  })

  it('rolls the whole run back when a scenario throws', async () => {
    await runSeed(env, SILENT_LOGGER, [], [primary])

    await expect(
      runSeed(env, SILENT_LOGGER, ['failing:boom'], [primary, failing]),
    ).rejects.toThrow(SCENARIO_FAILURE)

    expect(await storedEmails()).toEqual([PREPARED_EMAIL])
  })

  it('refuses a remote database before touching any module', async () => {
    await expect(
      runSeed({ ...env, DATABASE_URL: REMOTE_DATABASE_URL }, SILENT_LOGGER, [], [primary]),
    ).rejects.toThrow(SeedTargetError)

    expect(wipes).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose up -d --wait` then `pnpm test:integration tests/integration/seed-runner.spec.ts`
Expected: FAIL — `runSeed` is not exported by `#main/seeds/runner` (TypeError: runSeed is not a function / SyntaxError on the named import).

- [ ] **Step 3: Implement `runSeed`**

In `src/main/seeds/runner.ts`, replace the import block at the top with:

```ts
import { type Env, NODE_ENV_PRODUCTION } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import type { SeedModule, SeedScenario } from '#infra/database/seeds/seed-module'
import { createTransactionRunner } from '#infra/database/transaction-runner'
import type { WarnLogger } from '#infra/observability/logger'
import { SystemClock } from '#infra/providers/system-clock'
```

Add right after the `SEED_EXIT_BAD_INVOCATION` constant:

```ts
/**
 * Every module that publishes seed scenarios. Listed by hand, like `AUTH_MODULE`
 * in `run-cron.ts`: a module missed here silently has no seed, so the line has
 * to show up in a diff.
 */
export const SEED_MODULES: readonly SeedModule[] = []

/**
 * The two levels a run uses, declared as a shape for the reason `WarnLogger`
 * gives: pino's overloads rule out a hand-written double of `AppLogger`.
 */
export interface SeedLogger extends WarnLogger {
  info(details: Record<string, unknown>, message: string): void
}
```

Append at the end of the file:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:integration tests/integration/seed-runner.spec.ts`
Expected: PASS — 5 tests.

If "refuses a remote database" fails with a connection error instead of `SeedTargetError`, `assertSeedTarget(env)` is not the first statement of `runSeed` — move it back.

- [ ] **Step 5: Run the static gates**

Run each on its own: `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`.
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/seeds/runner.ts tests/integration/seed-runner.spec.ts
git commit -F - <<'EOF'
feat(seed): run the wipe and the scenarios in one transaction

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: The `auth` seed module

**Files:**
- Create: `src/modules/auth/infra/seeds/constants.ts`
- Create: `src/modules/auth/infra/seeds/factories.ts`
- Create: `src/modules/auth/infra/seeds/base-users.ts`
- Create: `src/modules/auth/infra/seeds/pending-registration.ts`
- Create: `src/modules/auth/infra/seeds/index.ts`
- Modify: `src/main/seeds/runner.ts` (`SEED_MODULES`)
- Test: `tests/integration/seed.spec.ts`

**Interfaces:**
- Consumes: `SeedModule`, `SeedScenario` (Task 1); `runSeed`, `SeedLogger`, `SEED_MODULES` (Task 2). From the codebase:
  - `User.create({ id, email, passwordHash, now })`, `User.createFederated({ id, email, now })` — `#modules/auth/entities/user`
  - `FederatedIdentity.create({ id, userId, provider, providerUserId, emailAtLink, now })`, `GOOGLE_PROVIDER` — `#modules/auth/entities/federated-identity`
  - `PendingRegistration.create({ id, email, codeHash, now, ttlSeconds })` — `#modules/auth/entities/pending-registration`
  - `new DrizzleUsersRepository(db).save(user)`, `new DrizzleFederatedIdentitiesRepository(db).save(identity)`, `new DrizzlePendingRegistrationsRepository(db).save(pending)` — `#modules/auth/infra/drizzle/drizzle-*-repository`
  - `Email.create(raw)` — `#modules/auth/value-objects/email`; `Password.create(raw).value` — `#modules/auth/value-objects/password`
  - `new Argon2HashProvider().hash(plain)` — `#modules/auth/infra/providers/argon2-hash-provider`
  - `new UuidIdGenerator().generate()` — `#infra/providers/uuid-id-generator`; `new Sha256TokenDigest().hash(value)` — `#infra/providers/sha256-token-digest`
- Produces: `authSeedModule: SeedModule<AuthSeedPreparation>`; constants `SEED_EMAIL_DOMAIN`, `SEED_PASSWORD`, `SEED_DEV_EMAIL`, `SEED_GOOGLE_EMAIL`, `SEED_PENDING_EMAIL`, `SEED_GOOGLE_SUBJECT`, `SEED_VERIFICATION_CODE`, `SEED_PENDING_REGISTRATION_TTL_SECONDS`, `AUTH_SEED_MODULE`, `BASE_USERS_SCENARIO`, `PENDING_REGISTRATION_SCENARIO`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/seed.spec.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { runSeed, type SeedLogger } from '#main/seeds/runner'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import {
  SEED_DEV_EMAIL,
  SEED_GOOGLE_EMAIL,
  SEED_GOOGLE_SUBJECT,
  SEED_PASSWORD,
  SEED_PENDING_EMAIL,
  SEED_VERIFICATION_CODE,
} from '#modules/auth/infra/seeds/constants'
import { arrangeAccount } from './setup/arrange-account.js'

// Spelled out rather than imported from the endpoints: these values ARE the
// wire contract.
const LOGIN_PATH = '/auth/login'
const CONFIRM_EMAIL_PATH = '/auth/email/verify'
const POST_METHOD = 'POST'
const OK_STATUS_CODE = 200
const GOOGLE_PROVIDER = 'google'

const ALL_FLAG = '--all'
const PENDING_REGISTRATION_TARGET = 'auth:pending-registration'
const ONE_LINK = 1

const OUTSIDER_EMAIL = 'joao@example.com'
const OUTSIDER_PASSWORD = 'sup3r-s3cr3t!'

const SILENT_LOGGER: SeedLogger = { info: () => {}, warn: () => {} }

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp(env)
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(federatedIdentities)
  await db.delete(passwordResetTokens)
  await db.delete(pendingRegistrations)
  await db.delete(users)
})

const post = (url: string, payload: object) =>
  app.inject({ method: POST_METHOD, url, payload })

async function snapshot() {
  const userRows = await db.select({ email: users.email }).from(users)
  const pendingRows = await db
    .select({ email: pendingRegistrations.email })
    .from(pendingRegistrations)
  const links = await db.select().from(federatedIdentities)
  return {
    userEmails: userRows.map((row) => row.email).sort(),
    pendingEmails: pendingRows.map((row) => row.email).sort(),
    linkCount: links.length,
  }
}

describe('auth seed', () => {
  it('creates a password account that logs in with the seed password', async () => {
    await runSeed(env, SILENT_LOGGER, [])

    const response = await post(LOGIN_PATH, {
      email: SEED_DEV_EMAIL,
      password: SEED_PASSWORD,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json()).toHaveProperty('accessToken')
  })

  it('creates a verified Google-only account with no password', async () => {
    await runSeed(env, SILENT_LOGGER, [])

    const [user] = await db.select().from(users).where(eq(users.email, SEED_GOOGLE_EMAIL))
    expect(user?.passwordHash).toBeNull()
    expect(user?.emailVerifiedAt).not.toBeNull()

    const links = await db
      .select()
      .from(federatedIdentities)
      .where(eq(federatedIdentities.userId, user?.id ?? ''))
    expect(links).toHaveLength(ONE_LINK)
    expect(links[0]?.provider).toBe(GOOGLE_PROVIDER)
    expect(links[0]?.providerUserId).toBe(SEED_GOOGLE_SUBJECT)
  })

  it('creates a pending registration that confirms with the known code', async () => {
    await runSeed(env, SILENT_LOGGER, [PENDING_REGISTRATION_TARGET])

    const response = await post(CONFIRM_EMAIL_PATH, {
      email: SEED_PENDING_EMAIL,
      code: SEED_VERIFICATION_CODE,
      password: SEED_PASSWORD,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
  })

  it('lands on the same state when run twice', async () => {
    await runSeed(env, SILENT_LOGGER, [ALL_FLAG])
    const afterFirstRun = await snapshot()
    await runSeed(env, SILENT_LOGGER, [ALL_FLAG])

    expect(afterFirstRun).toEqual({
      userEmails: [SEED_DEV_EMAIL, SEED_GOOGLE_EMAIL].sort(),
      pendingEmails: [SEED_PENDING_EMAIL],
      linkCount: ONE_LINK,
    })
    expect(await snapshot()).toEqual(afterFirstRun)
  })

  it('leaves an account outside the seed namespace alone', async () => {
    await arrangeAccount(db, { email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD })

    await runSeed(env, SILENT_LOGGER, [ALL_FLAG])
    await runSeed(env, SILENT_LOGGER, [ALL_FLAG])

    const outsider = await db.select().from(users).where(eq(users.email, OUTSIDER_EMAIL))
    expect(outsider).toHaveLength(ONE_LINK)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration tests/integration/seed.spec.ts`
Expected: FAIL — cannot resolve `#modules/auth/infra/seeds/constants`.

- [ ] **Step 3: Create the constants**

Create `src/modules/auth/infra/seeds/constants.ts`:

```ts
/** The module prefix on the command line: `auth:base-users`. */
export const AUTH_SEED_MODULE = 'auth'
export const BASE_USERS_SCENARIO = 'base-users'
export const PENDING_REGISTRATION_SCENARIO = 'pending-registration'

/** Every seed address lives under this domain, and `wipe` deletes by it. */
export const SEED_EMAIL_DOMAIN = 'seed.local'

export const SEED_DEV_EMAIL = `dev@${SEED_EMAIL_DOMAIN}`
export const SEED_GOOGLE_EMAIL = `google@${SEED_EMAIL_DOMAIN}`
export const SEED_PENDING_EMAIL = `pending@${SEED_EMAIL_DOMAIN}`

/**
 * Shared by every seed account that has a password. Development-only and
 * documented in the module README — never logged. Satisfies the `Password`
 * policy, so it also works as the password of a confirm or a reset.
 */
export const SEED_PASSWORD = 'seed-Dev-2026!'

/** Stands in for Google's `sub`. Real subjects are numeric, so this never collides with one. */
export const SEED_GOOGLE_SUBJECT = 'seed-google-subject'

/** Six digits, the shape `POST /auth/email/verify` accepts. */
export const SEED_VERIFICATION_CODE = '123456'

const SECONDS_PER_DAY = 86_400
const SEED_PENDING_REGISTRATION_TTL_DAYS = 7
/** Days, not the module's minutes: a code seeded in the morning must still confirm in the afternoon. */
export const SEED_PENDING_REGISTRATION_TTL_SECONDS =
  SEED_PENDING_REGISTRATION_TTL_DAYS * SECONDS_PER_DAY
```

- [ ] **Step 4: Create the factories and the wipe**

Create `src/modules/auth/infra/seeds/factories.ts`:

```ts
import { sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { Sha256TokenDigest } from '#infra/providers/sha256-token-digest'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'
import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { User } from '#modules/auth/entities/user'
import { DrizzleFederatedIdentitiesRepository } from '#modules/auth/infra/drizzle/drizzle-federated-identities-repository'
import { DrizzlePendingRegistrationsRepository } from '#modules/auth/infra/drizzle/drizzle-pending-registrations-repository'
import { DrizzleUsersRepository } from '#modules/auth/infra/drizzle/drizzle-users-repository'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Email } from '#modules/auth/value-objects/email'
import { SEED_EMAIL_DOMAIN } from './constants.js'

/** What `authSeedModule.prepare` computes once, outside the transaction. */
export interface AuthSeedPreparation {
  readonly passwordHash: string
}

const LIKE_ANY_PREFIX = '%@'

const ids = new UuidIdGenerator()
const tokenDigest = new Sha256TokenDigest()

/**
 * Every write goes through the entity and the Drizzle repository the API uses
 * (design §3.2), so a seeded row satisfies the same invariants and mapper as a
 * registered one.
 */
export async function createPasswordUser(
  tx: Database,
  params: { email: string; passwordHash: string; now: Date },
): Promise<User> {
  const user = User.create({
    id: ids.generate(),
    email: Email.create(params.email),
    passwordHash: params.passwordHash,
    now: params.now,
  })
  await new DrizzleUsersRepository(tx).save(user)
  return user
}

export async function createGoogleUser(
  tx: Database,
  params: { email: string; providerUserId: string; now: Date },
): Promise<User> {
  const user = User.createFederated({
    id: ids.generate(),
    email: Email.create(params.email),
    now: params.now,
  })
  await new DrizzleUsersRepository(tx).save(user)
  await new DrizzleFederatedIdentitiesRepository(tx).save(
    FederatedIdentity.create({
      id: ids.generate(),
      userId: user.id,
      provider: GOOGLE_PROVIDER,
      providerUserId: params.providerUserId,
      emailAtLink: user.email,
      now: params.now,
    }),
  )
  return user
}

export async function createPendingRegistration(
  tx: Database,
  params: { email: string; code: string; ttlSeconds: number; now: Date },
): Promise<void> {
  await new DrizzlePendingRegistrationsRepository(tx).save(
    PendingRegistration.create({
      id: ids.generate(),
      email: Email.create(params.email),
      codeHash: tokenDigest.hash(params.code),
      now: params.now,
      ttlSeconds: params.ttlSeconds,
    }),
  )
}

/**
 * The one raw write of the seed: the repositories have no delete-by-domain, and
 * production code has no reason to. `refresh_tokens`, `federated_identities`
 * and `password_reset_tokens` go with `users` by cascade;
 * `pending_registrations` has no foreign key and is deleted explicitly.
 */
export async function wipeAuthSeedNamespace(tx: Database): Promise<void> {
  const pattern = `${LIKE_ANY_PREFIX}${SEED_EMAIL_DOMAIN}`
  await tx.delete(users).where(sql`lower(${users.email}) like ${pattern}`)
  await tx
    .delete(pendingRegistrations)
    .where(sql`lower(${pendingRegistrations.email}) like ${pattern}`)
}
```

- [ ] **Step 5: Create the two scenarios**

Create `src/modules/auth/infra/seeds/base-users.ts`:

```ts
import type { SeedScenario } from '#infra/database/seeds/seed-module'
import {
  BASE_USERS_SCENARIO,
  SEED_DEV_EMAIL,
  SEED_GOOGLE_EMAIL,
  SEED_GOOGLE_SUBJECT,
} from './constants.js'
import {
  type AuthSeedPreparation,
  createGoogleUser,
  createPasswordUser,
} from './factories.js'

export const baseUsers: SeedScenario<AuthSeedPreparation> = {
  name: BASE_USERS_SCENARIO,
  description: `${SEED_DEV_EMAIL} with the seed password, and ${SEED_GOOGLE_EMAIL} with Google only`,
  byDefault: true,
  async run({ tx, now, preparation, log }) {
    await createPasswordUser(tx, {
      email: SEED_DEV_EMAIL,
      passwordHash: preparation.passwordHash,
      now,
    })
    log(`account ${SEED_DEV_EMAIL}`)

    await createGoogleUser(tx, {
      email: SEED_GOOGLE_EMAIL,
      providerUserId: SEED_GOOGLE_SUBJECT,
      now,
    })
    log(`Google-only account ${SEED_GOOGLE_EMAIL}`)
  },
}
```

Create `src/modules/auth/infra/seeds/pending-registration.ts`:

```ts
import type { SeedScenario } from '#infra/database/seeds/seed-module'
import {
  PENDING_REGISTRATION_SCENARIO,
  SEED_PENDING_EMAIL,
  SEED_PENDING_REGISTRATION_TTL_SECONDS,
  SEED_VERIFICATION_CODE,
} from './constants.js'
import { type AuthSeedPreparation, createPendingRegistration } from './factories.js'

export const pendingRegistration: SeedScenario<AuthSeedPreparation> = {
  name: PENDING_REGISTRATION_SCENARIO,
  description: `${SEED_PENDING_EMAIL} awaiting confirmation with code ${SEED_VERIFICATION_CODE}`,
  async run({ tx, now, log }) {
    await createPendingRegistration(tx, {
      email: SEED_PENDING_EMAIL,
      code: SEED_VERIFICATION_CODE,
      ttlSeconds: SEED_PENDING_REGISTRATION_TTL_SECONDS,
      now,
    })
    log(`pending registration ${SEED_PENDING_EMAIL}`)
  },
}
```

- [ ] **Step 6: Create the module**

Create `src/modules/auth/infra/seeds/index.ts`:

```ts
import type { SeedModule } from '#infra/database/seeds/seed-module'
import { Argon2HashProvider } from '#modules/auth/infra/providers/argon2-hash-provider'
import { Password } from '#modules/auth/value-objects/password'
import { baseUsers } from './base-users.js'
import { AUTH_SEED_MODULE, SEED_PASSWORD } from './constants.js'
import { type AuthSeedPreparation, wipeAuthSeedNamespace } from './factories.js'
import { pendingRegistration } from './pending-registration.js'

export const authSeedModule: SeedModule<AuthSeedPreparation> = {
  name: AUTH_SEED_MODULE,
  scenarios: [baseUsers, pendingRegistration],
  /**
   * One argon2 for the whole run: every seed account shares the password.
   * Through `Password.create` so a constant that drifts below the policy fails
   * here, not at a confirm.
   */
  async prepare() {
    const password = Password.create(SEED_PASSWORD)
    return { passwordHash: await new Argon2HashProvider().hash(password.value) }
  },
  async wipe(tx) {
    await wipeAuthSeedNamespace(tx)
  },
}
```

- [ ] **Step 7: Register the module in the runner**

In `src/main/seeds/runner.ts`, add to the imports (Biome orders it after `#infra/*`):

```ts
import { authSeedModule } from '#modules/auth/infra/seeds/index'
```

and change

```ts
export const SEED_MODULES: readonly SeedModule[] = []
```

to

```ts
export const SEED_MODULES: readonly SeedModule[] = [authSeedModule]
```

If `pnpm typecheck` rejects this assignment with a variance error on `run` or `prepare`, one of them was written as a function-typed property in `seed-module.ts` instead of method syntax — fix the contract, never cast here.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/seed.spec.ts tests/integration/seed-runner.spec.ts`
Expected: PASS — 10 tests.

- [ ] **Step 9: Run the static gates**

Run each on its own: `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`.
Expected: all exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/modules/auth/infra/seeds src/main/seeds/runner.ts tests/integration/seed.spec.ts
git commit -F - <<'EOF'
feat(auth): seed scenarios for base users and a pending registration

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: CLI shell and `db:*` scripts

**Files:**
- Create: `src/main/seeds/index.ts`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: `env` (`#infra/config/env`), `createLogger` (`#infra/observability/logger`), and from `./runner.js`: `LIST_FLAG`, `SEED_EXIT_OK`, `SEED_MODULES`, `formatScenarioList`, `qualifyScenarios`, `runSeed`, `seedExitCodeFor`.
- Produces: the `pnpm db:seed` command; `pnpm db:up`, `db:down`, `db:logs`, `db:studio`; `db:generate`/`db:migrate` reading `.env`.

This task has no automated test of its own, like `src/main/cron.ts`: the shell only wires argv, the logger and the exit code around functions Tasks 1–3 already test. Its verification is running the command for real.

- [ ] **Step 1: Create the CLI shell**

Create `src/main/seeds/index.ts`:

```ts
import { env } from '#infra/config/env'
import { createLogger } from '#infra/observability/logger'
import {
  formatScenarioList,
  LIST_FLAG,
  qualifyScenarios,
  runSeed,
  SEED_EXIT_OK,
  SEED_MODULES,
  seedExitCodeFor,
} from './runner.js'

/** `process.argv` is `[node, script, ...args]`. */
const FIRST_ARG_INDEX = 2
const LINE_BREAK = '\n'

const SEED_RUN_COMPLETE = 'seed run complete'
const SEED_RUN_ABORTED = 'seed run aborted'

const logger = createLogger(env)
const args = process.argv.slice(FIRST_ARG_INDEX)

// Listing is output for a human, not an event: stdout, not the logger.
if (args.includes(LIST_FLAG)) {
  const lines = formatScenarioList(qualifyScenarios(SEED_MODULES))
  process.stdout.write(`${lines.join(LINE_BREAK)}${LINE_BREAK}`)
  process.exit(SEED_EXIT_OK)
}

try {
  const scenarios = await runSeed(env, logger, args)
  logger.info({ scenarios }, SEED_RUN_COMPLETE)
  process.exit(SEED_EXIT_OK)
} catch (error) {
  logger.error({ err: error, args }, SEED_RUN_ABORTED)
  process.exit(seedExitCodeFor(error))
}
```

- [ ] **Step 2: Add the scripts**

In `package.json`, replace the two lines

```json
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
```

with

```json
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down",
    "db:logs": "docker compose logs -f postgres",
    "db:generate": "node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs generate",
    "db:migrate": "node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs migrate",
    "db:studio": "node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs studio",
    "db:seed": "node --conditions=development --env-file-if-exists=.env --import tsx src/main/seeds/index.ts"
```

- [ ] **Step 3: Verify the commands against the development database**

Requires a `.env` at the repository root (copy `.env.example` if missing). Run each and compare:

1. `pnpm db:up` — Expected: the three containers report healthy/started, exit 0.
2. `pnpm db:migrate` — Expected: migrations applied (or "no migrations to apply"), exit 0. This proves drizzle-kit now reads `DATABASE_URL` from `.env`.
3. `pnpm db:seed --list; echo "exit=$?"` — Expected:
   ```text
   auth:base-users (default) — dev@seed.local with the seed password, and google@seed.local with Google only
   auth:pending-registration — pending@seed.local awaiting confirmation with code 123456
   exit=0
   ```
4. `pnpm db:seed; echo "exit=$?"` — Expected: log lines `account dev@seed.local`, `Google-only account google@seed.local`, then `seed run complete` with `scenarios: ["auth:base-users"]`; `exit=0`. No line contains the seed password.
5. `pnpm db:seed --all; echo "exit=$?"` — Expected: both scenarios logged, `exit=0`. Run it a second time — same output, `exit=0`.
6. `docker exec api-clean-platform-postgres psql -U api_clean_platform -d api_clean_platform -c "select email, password_hash is null as no_password from users where email like '%@seed.local' order by email"` — Expected: `dev@seed.local | f` and `google@seed.local | t`, two rows.
7. `pnpm db:seed auth:nope; echo "exit=$?"` — Expected: `seed run aborted` naming `unknown seed target "auth:nope"` and the known targets; `exit=2`.
8. `DATABASE_URL=postgres://user:pass@db.example.com:5432/app pnpm db:seed; echo "exit=$?"` — Expected: `seed run aborted` with `refusing to seed a database outside this machine: "db.example.com"`; `exit=1`. This also proves a variable already in the shell wins over `.env`, which is what keeps the CI `db:migrate` step unchanged.

`NODE_ENV=production` is not exercised here: in production `env.ts` also demands the mail settings and exits before the seed runs, so the manual run would pass for the wrong reason. The unit test in Task 1 covers that guard.

- [ ] **Step 4: Verify seeds stay out of the build**

Run: `pnpm build` then
`test ! -e dist/main/seeds && test ! -e dist/modules/auth/infra/seeds && test ! -e dist/infra/database/seeds && echo "seeds excluded"`
Expected: build exits 0 and the line `seeds excluded` prints. A build error here means production code imports a seed file.

- [ ] **Step 5: Run the static gates**

Run each on its own: `pnpm lint`, `pnpm typecheck`.
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/seeds/index.ts package.json
git commit -F - <<'EOF'
feat(seed): db:seed CLI and the db:up/down/logs/studio scripts

drizzle-kit commands now load .env, so DATABASE_URL no longer has to be
exported in the shell.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Documentation and architecture audit

**Files:**
- Modify: `ARCHITECTURE.md` (§2 tree, §10 commands)
- Modify: `docs/DECISIONS.md` (index table, new decision 32)
- Modify: `src/modules/auth/README.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: the file layout and commands from Tasks 1–4.
- Produces: documentation only.

- [ ] **Step 1: ARCHITECTURE §2 — the tree**

In `ARCHITECTURE.md`, replace

```text
│   │   ├── transaction-runner.ts   # abre a transação, faz commit/rollback e recusa aninhamento
│   │   └── unit-of-work.ts         # createUnitOfWork(runner, buildRepos) — casca genérica (decisão 22)
```

with

```text
│   │   ├── transaction-runner.ts   # abre a transação, faz commit/rollback e recusa aninhamento
│   │   ├── unit-of-work.ts         # createUnitOfWork(runner, buildRepos) — casca genérica (decisão 22)
│   │   └── seeds/
│   │       └── seed-module.ts      # contrato do seed de dev; fora do dist (decisão 32)
```

replace

```text
│           ├── in-memory/           # repositório de teste (decisão 09)
```

with

```text
│           ├── in-memory/           # repositório de teste (decisão 09)
│           ├── seeds/               # cenários de `pnpm db:seed` do módulo; fora do dist (decisão 32)
```

and replace

```text
    ├── app.ts                      # compõe a aplicação: docs + rotas + deps, SEM escutar
    └── http.ts                     # entrypoint: sobe o servidor e trata shutdown
```

with

```text
    ├── app.ts                      # compõe a aplicação: docs + rotas + deps, SEM escutar
    ├── http.ts                     # entrypoint: sobe o servidor e trata shutdown
    └── seeds/
        ├── index.ts                # entrypoint de `pnpm db:seed`: argv, log, exit code
        └── runner.ts               # travas de alvo, seleção, ordem, uma transação (decisão 32)
```

- [ ] **Step 2: ARCHITECTURE §10 — the commands**

In `ARCHITECTURE.md` §10, replace

```bash
pnpm db:migrate        # drizzle-kit migrate — aplica migrations pendentes
```

with

```bash
pnpm db:migrate        # drizzle-kit migrate — aplica migrations pendentes (lê o .env)
pnpm db:up             # docker compose up -d --wait — postgres, postgres-test e mailpit
pnpm db:down           # docker compose down — o volume do dev sobrevive
pnpm db:logs           # logs do postgres de dev
pnpm db:studio         # drizzle-kit studio
pnpm db:seed           # estado conhecido no banco LOCAL: cenários default (--list, --all, auth, auth:<cenário>)
```

- [ ] **Step 3: DECISIONS — index rows**

In `docs/DECISIONS.md`, replace the index row

```markdown
| 30 | Cron / poda | `cron.ts` one-shot + scheduler externo; registry de jobs por módulo; poda com janela de retenção por tabela |
```

with

```markdown
| 30 | Cron / poda | `cron.ts` one-shot + scheduler externo; registry de jobs por módulo; poda com janela de retenção por tabela |
| 31 | Login com Google | Client-driven, verificação de ID token, sem merge silencioso |
| 32 | Seed de dev | Cenários por módulo fora do container; runner em `main/`; `wipe` por namespace; só banco local |
```

(Row 31 was missing from the index; the decision itself exists.)

- [ ] **Step 4: DECISIONS — decision 32**

In `docs/DECISIONS.md`, replace

```markdown
---

## 3. Defaults assumidos
```

with

````markdown
---

### 32 — Seed de dev: cenários por módulo, runner no composition root, só banco local

`pnpm db:seed` leva o banco **local** a um estado conhecido. Paridade de uso com
o `db:seed` do byteflow; a estrutura diverge onde as fronteiras daqui exigem.

**Cenários por módulo, fora do container.** Cada módulo publica um `SeedModule`
em `modules/<m>/infra/seeds/`; `main/seeds/runner.ts` os lista à mão
(`SEED_MODULES`), como o `run-cron.ts` lista os jobs, e qualifica os nomes
(`auth:base-users`). Nada de seed entra no container: dado de dev fica fora do
grafo de produção. `**/seeds/**` sai do `dist` pelo `tsconfig.build.json`.

**O contrato mora em `#infra`.** Em `#main` o seed do módulo dispararia
`INFRA-MAIN`; em `#shared`, camada pura, não poderia citar `Database`.

**Escrita por entidade + repositório.** As factories usam `User.create`,
`FederatedIdentity.create`, `PendingRegistration.create` e os repositórios
Drizzle — as invariantes e os mappers valem para o seed como para a API. A única
escrita crua é o `wipe`.

**Uma transação; `wipe` de todos os módulos.** Cada módulo apaga o próprio
namespace (no `auth`, `@seed.local`) em ordem inversa, e só então os cenários
rodam. Todos os módulos, não só os selecionados: sem FK entre módulos
(decisão 24), nenhuma cascata limpa um pelo outro. O `prepare()` de cada módulo
roda antes da transação — é onde o argon2 da senha de seed vai.

**Duas travas de alvo, sem flag de contorno.** Recusa `NODE_ENV=production` e
qualquer host de `DATABASE_URL` fora de `localhost`/`127.0.0.1`/`::1`. A segunda
existe porque `NODE_ENV` tem `development` como default: um shell de servidor
sem a variável passaria pela primeira e plantaria uma conta com senha publicada.
Semear staging, se um dia fizer sentido, é outra decisão.

**Descartados.** `src/seeds/` global (cópia literal do byteflow): cai em
`LAYER-UNKNOWN` e concentra o concreto de todos os módulos num lugar só. Seed via
use cases: exige ler o código de seis dígitos do e-mail, não alcança conta
só-Google sem fake, e não cabe numa transação — cada use case abre a sua, e o
runner recusa aninhamento.

Desenho completo em
[`specs/2026-09-14-dev-database-seed-design.md`](superpowers/specs/2026-09-14-dev-database-seed-design.md).

---

## 3. Defaults assumidos
````

- [ ] **Step 5: auth README — the seed accounts**

In `src/modules/auth/README.md`, replace

```markdown
## Formato de erro
```

with

```markdown
## Dados de seed (desenvolvimento)

`pnpm db:seed` cria, **só no banco local**, contas sob `@seed.local` — rodar de
novo apaga e recria esse namespace, e nada fora dele. Constantes em
`infra/seeds/constants.ts`.

| Cenário | Conta | Como usar |
|---|---|---|
| `auth:base-users` (default) | `dev@seed.local` | login com a senha `seed-Dev-2026!` |
| | `google@seed.local` | só Google, sem senha — login por senha responde `401` |
| `auth:pending-registration` | `pending@seed.local` | `POST /auth/email/verify` com o código `123456` e uma senha válida |

A senha fica aqui e na constante, nunca no log do seed.

## Formato de erro
```

- [ ] **Step 6: TODO — record the tooling and fix the CORS entry**

In `docs/TODO.md`, replace

```markdown
| CORS | primeiro front web | sem ele o modo cookie não funciona cross-origin |
```

with

```markdown
| ~~CORS~~ | — | **já existe** em `src/infra/http/cors.ts` (lista de origens permitidas, registrado no `buildApp`). Entrou sem decisão no `DECISIONS.md` — registrar quando o primeiro front web definir a política |
```

and replace

```markdown
> **Fatia 14 (2026-09-08) entregou o login com Google client-driven.** `POST
```

with

```markdown
> **Fatia 15 (2026-09-14) entregou o seed do banco local** (`pnpm db:seed`,
> decisão 32) e os scripts `db:up`/`db:down`/`db:logs`/`db:studio`. É tooling de
> desenvolvimento: não fecha nenhum item abaixo, e a ordem de urgência não muda.
>
> **Fatia 14 (2026-09-08) entregou o login com Google client-driven.** `POST
```

- [ ] **Step 7: Run the architecture audit over the branch**

Run: `node .claude/skills/architecture-audit/scripts/audit-scan.mjs --base main`
Expected: `CRÍTICA 0  ALTA 0  MÉDIA 0  BAIXA 0`. Any finding is fixed in the task's own files before continuing — never by editing the scanner.

- [ ] **Step 8: Run every gate**

Run each on its own (containers up):
- `pnpm lint` — exit 0
- `pnpm typecheck` — exit 0
- `pnpm test:unit` — all green
- `pnpm test:integration` — all green, including `seed.spec.ts` and `seed-runner.spec.ts`

- [ ] **Step 9: Commit**

```bash
git add ARCHITECTURE.md docs/DECISIONS.md src/modules/auth/README.md docs/TODO.md
git commit -F - <<'EOF'
docs(seed): record the dev database seed (decision 32, README, TODO)

Also adds the missing decision 31 row to the index and corrects the TODO
entry that still listed CORS as pending.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

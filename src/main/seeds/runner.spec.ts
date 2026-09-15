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
    expect(names(selectScenarios(ALL, ['auth']))).toEqual([
      'auth:base-users',
      'auth:pending',
    ])
  })

  it('selects one scenario by its qualified name', () => {
    expect(names(selectScenarios(ALL, ['billing:invoices']))).toEqual([
      'billing:invoices',
    ])
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

    expect(names(resolveOrder(ALL, requested))).toEqual([
      'auth:base-users',
      'auth:pending',
    ])
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
      expect(() =>
        assertSeedTarget({ NODE_ENV: DEVELOPMENT, DATABASE_URL: url }),
      ).not.toThrow()
      expect(() => assertSeedTarget({ NODE_ENV: TEST, DATABASE_URL: url })).not.toThrow()
    },
  )
})

describe('seedExitCodeFor', () => {
  it('separates a bad command line from a failed run', () => {
    expect(seedExitCodeFor(new SeedInvocationError('typo'))).toBe(
      SEED_EXIT_BAD_INVOCATION,
    )
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

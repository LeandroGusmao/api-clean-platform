import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const FIXTURE_SUFFIX = '.txt'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const DEPCRUISE_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'depcruise')
const CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.mjs')
const CRUISED_ROOT = 'src'
const MAX_REPORT_BYTES = 32 * 1024 * 1024
const WORKSPACE_PREFIX = 'boundaries-'
const FIXTURE_PACKAGE_NAME = 'boundaries-fixtures'
/** The fixture tree's own files. Resolved externals are not counted. */
const EXPECTED_FIXTURE_MODULE_COUNT = 17

/** fixture path, as dependency-cruiser reports it -> the ONE rule it must trip. */
const NEGATIVES = {
  'src/modules/auth/use-cases/n1-pure-to-infra.ts': 'pure-imports-only-pure',
  'src/modules/auth/use-cases/n2-pure-external.ts': 'pure-external-only-zod',
  'src/modules/auth/infra/http/n3-cross-module-infra.ts': 'module-does-not-reach-module',
  'src/modules/billing/use-cases/n4-cross-module-pure.ts': 'module-does-not-reach-module',
  'src/shared/n5-shared-knows-module.ts': 'shared-does-not-know-modules',
  'src/infra/http/n6-global-infra-to-double.ts':
    'global-infra-imports-pure-or-global-infra',
  'src/modules/auth/infra/http/n7-container-as-value.ts': 'own-container-type-only',
  'src/main/n8-unresolvable.ts': 'no-unresolvable-imports',
}

const POSITIVES = [
  'src/modules/auth/use-cases/p1-reaches-double.spec.ts',
  'src/main/adapters/p2-cross-module-adapter.ts',
]

const IMPORTS_MAP = {
  '#modules/*': { development: './src/modules/*.ts', default: './dist/modules/*.js' },
  '#shared/*': { development: './src/shared/*.ts', default: './dist/shared/*.js' },
  '#infra/*': { development: './src/infra/*.ts', default: './dist/infra/*.js' },
  '#main/*': { development: './src/main/*.ts', default: './dist/main/*.js' },
}

const violationsByFile = new Map()
let fixtureModuleCount = 0
let workspace = ''

/** Renames every `*.ts.txt` back to `*.ts`, depth first. */
function materialize(directory) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) materialize(full)
    else if (entry.endsWith(FIXTURE_SUFFIX)) {
      renameSync(full, full.slice(0, -FIXTURE_SUFFIX.length))
    }
  }
}

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), WORKSPACE_PREFIX))
  cpSync(path.join(HERE, 'fixtures'), workspace, { recursive: true })
  materialize(workspace)

  cpSync(path.join(REPO_ROOT, 'tsconfig.json'), path.join(workspace, 'tsconfig.json'))
  // The subpath imports map is what `#modules/*` resolves through, and the
  // `development` condition is what points it at src/ instead of dist/.
  writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: FIXTURE_PACKAGE_NAME, type: 'module', imports: IMPORTS_MAP }),
  )
  // Without the real node_modules, `pg` does not resolve and n2 trips
  // `no-unresolvable-imports` instead of the allowlist rule.
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(workspace, 'node_modules'))

  let raw = ''
  try {
    raw = execFileSync(
      DEPCRUISE_BIN,
      [CRUISED_ROOT, '--config', CONFIG, '--output-type', 'json'],
      {
        cwd: workspace,
        encoding: 'utf8',
        maxBuffer: MAX_REPORT_BYTES,
      },
    )
  } catch (error) {
    // dependency-cruiser exits 1 when it finds violations, which is the whole
    // point of the negative fixtures. The report is still on stdout.
    raw = error.stdout
  }

  const report = JSON.parse(raw)
  fixtureModuleCount = report.modules.filter((module) =>
    module.source.startsWith(`${CRUISED_ROOT}/`),
  ).length
  for (const module of report.modules) {
    for (const dependency of module.dependencies) {
      for (const rule of dependency.rules ?? []) {
        if (!violationsByFile.has(module.source))
          violationsByFile.set(module.source, new Set())
        violationsByFile.get(module.source).add(rule.name)
      }
    }
  }
})

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
})

describe('boundary rules', () => {
  // A config that cruises nothing reports zero violations and exits 0. This is
  // what tells "clean" apart from "blind" (ARCHITECTURE.md §4).
  it('actually cruised the fixture tree', () => {
    expect(fixtureModuleCount).toBe(EXPECTED_FIXTURE_MODULE_COUNT)
  })

  for (const [file, rule] of Object.entries(NEGATIVES)) {
    it(`trips ${rule} on ${path.basename(file)}`, () => {
      expect([...(violationsByFile.get(file) ?? [])]).toEqual([rule])
    })
  }

  for (const file of POSITIVES) {
    it(`leaves ${path.basename(file)} alone`, () => {
      expect([...(violationsByFile.get(file) ?? [])]).toEqual([])
    })
  }
})

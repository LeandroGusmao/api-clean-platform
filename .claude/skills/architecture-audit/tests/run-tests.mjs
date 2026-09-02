#!/usr/bin/env node
// Regression test for audit-scan.mjs. Run it after ANY edit to the scanner or
// to the boundary rules in ARCHITECTURE.md:
//
//   node .claude/skills/architecture-audit/tests/run-tests.mjs
//
// It asserts both directions, and the second one is the one that keeps the
// audit trustworthy: a check that fires on correct code trains the reviewer to
// ignore the report.
//
//   1. Every planted violation is detected, at the right line.
//   2. The two CLEAN fixtures produce ZERO findings.
//
// Fixtures are stored as `.ts.txt` so neither tsc (`include` is src/ + tests/)
// nor Biome ever parses code that violates the rules on purpose. The runner
// materializes them into a temp directory under their real `.ts` names.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scanner = path.join(here, '..', 'scripts', 'audit-scan.mjs')
const FIXTURE_SUFFIX = '.txt'

/** fixture path (as the scanner reports it) -> expected `CHECK:line` list. */
const EXPECTED = {
  'src/modules/billing/use-cases/charge-customer.ts': [
    'PURE-IO:1',
    'PURE-IO:2',
    'PURE-IO:3',
    'PURE-XMOD:4',
    'PURE-CONTAINER:4',
    'ENV:11',
    'R7-CLOCK:15',
    'R7-RANDOM:16',
    'R7-RANDOM:17',
  ],
  'src/modules/billing/infra/drizzle/drizzle-invoices-repository.ts': [
    'XMOD-INFRA:1',
    'IMPORT-EXT:2',
    'IMPORT-PARENT:3',
    'DRIVER-RETHROW:9',
    'DRIVER-LOG:10',
    'LOG-ERR-MODULE:10',
    'DRIZZLE-QUERY-API:16',
  ],
  'src/modules/billing/infra/http/endpoints/invoice.ts': [
    'ZOD-DATE:4',
    'HTTP-MAGIC:9',
    'HANDLER-CATCH:11',
    'LOG-OBJECT:12',
    'CONSOLE:14',
    'SECRET-HTTP:16',
    'HTTP-MAGIC:16',
    'LOG-ERR-MODULE:18',
  ],
  'src/modules/billing/use-cases/get-invoice.ts': ['OWNERSHIP-UNUSED:12'],
  'src/modules/billing/errors/invoice-not-found-error.ts': ['ERROR-BASE:5'],
  'src/modules/billing/errors/duplicate-order-error.ts': [],
  'src/shared/errors/app-error.ts': [],
  'src/modules/billing/ports/mailer.ts': ['PURE-IO:1'],
  'docs/broken-links.md': ['MD-LINK:4', 'MD-LINK:5'],
  'docs/good-neighbour.md': [],
  'src/shared/utils/random-id.ts': ['PURE-IO:1', 'R7-RANDOM:3'],
  'src/infra/http/tenant-guard.ts': ['GLOBAL-INFRA-XMOD:1'],
  'src/modules/billing/helpers.ts': ['LAYER-UNKNOWN:1'],
  // `services/` is `pure`, so the driver import has to be caught here. Before
  // that folder entered the boundary table it was LAYER-UNKNOWN instead, and
  // an unclassified file is checked by nothing at all.
  'src/modules/billing/services/invoice-numberer.ts': ['PURE-IO:1'],
  'tests/integration/billing.spec.ts': ['TEST-ENV:3', 'TEST-ONLY:5'],
  // Correct code. A single finding here is a false positive, and a false
  // positive is worse than a missed check: it teaches people to skim.
  'src/modules/billing/use-cases/refund-order.ts': [],
  'src/modules/billing/services/order-pricer.ts': [],
  'src/modules/billing/infra/drizzle/drizzle-orders-repository.ts': [],
}

function materialize(source, destination) {
  cpSync(source, destination, { recursive: true })

  const rename = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) rename(full)
      else if (entry.endsWith(FIXTURE_SUFFIX)) {
        renameSync(full, full.slice(0, -FIXTURE_SUFFIX.length))
      }
    }
  }
  rename(destination)
}

const workspace = mkdtempSync(path.join(tmpdir(), 'audit-fixtures-'))
let failures = 0

try {
  materialize(path.join(here, 'fixtures'), path.join(workspace, 'fixtures'))

  const raw = execFileSync(
    process.execPath,
    [scanner, '--json', path.join(workspace, 'fixtures')],
    { encoding: 'utf8' },
  )
  const { findings } = JSON.parse(raw)

  const actual = {}
  for (const finding of findings) {
    const key = finding.file.slice(finding.file.indexOf('fixtures/') + 'fixtures/'.length)
    if (actual[key] === undefined) actual[key] = []
    actual[key].push(`${finding.check}:${finding.line}`)
  }

  for (const [fixture, expected] of Object.entries(EXPECTED)) {
    const got = actual[fixture] ?? []
    const missing = expected.filter((item) => !got.includes(item))
    const extra = got.filter((item) => !expected.includes(item))

    if (missing.length === 0 && extra.length === 0) {
      console.log(`ok    ${fixture} (${expected.length})`)
      continue
    }

    failures += 1
    console.log(`FAIL  ${fixture}`)
    if (missing.length > 0) console.log(`        não detectado: ${missing.join(', ')}`)
    if (extra.length > 0) console.log(`        falso positivo: ${extra.join(', ')}`)
  }

  const unknown = Object.keys(actual).filter((file) => !(file in EXPECTED))
  for (const file of unknown) {
    failures += 1
    console.log(`FAIL  ${file} não está no manifesto: ${actual[file].join(', ')}`)
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

console.log(
  failures === 0 ? '\nTodos os casos passaram.' : `\n${failures} caso(s) falhou(ram).`,
)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { assertEveryFileClassified, assertEveryFileCruised } from './coverage.mjs'
import { assertTranspilerSupported, readTranspilerState } from './preflight.mjs'

const DEPCRUISE_BIN = 'node_modules/.bin/depcruise'
const CRUISED_ROOT = 'src'
const SOURCE_GLOB = 'src/**/*.ts'
const CONFIG = '.dependency-cruiser.mjs'
const JSON_REPORTER = 'json'
const HUMAN_REPORTER = 'err-long'
const MAX_REPORT_BYTES = 32 * 1024 * 1024
const FAILURE_EXIT_CODE = 1

const { resolvedVersion, supportedRange } = readTranspilerState()
assertTranspilerSupported(resolvedVersion, supportedRange)

let raw = ''
try {
  raw = execFileSync(
    DEPCRUISE_BIN,
    [CRUISED_ROOT, '--config', CONFIG, '--output-type', JSON_REPORTER],
    {
      encoding: 'utf8',
      maxBuffer: MAX_REPORT_BYTES,
    },
  )
} catch (error) {
  // dependency-cruiser exits 1 when it finds violations; the report is still
  // on stdout, and the violations are printed further down.
  if (typeof error.stdout !== 'string') throw error
  raw = error.stdout
}

const report = JSON.parse(raw)
const cruisedSources = report.modules
  .map((module) => module.source)
  .filter((source) => source.startsWith(`${CRUISED_ROOT}/`))

assertEveryFileCruised(cruisedSources, globSync(SOURCE_GLOB))
assertEveryFileClassified(cruisedSources)

if (report.summary.error > 0) {
  try {
    // Second pass only to print the violations the way a human reads them.
    // It exits 1 for the same reason this script is about to.
    execFileSync(
      DEPCRUISE_BIN,
      [CRUISED_ROOT, '--config', CONFIG, '--output-type', HUMAN_REPORTER],
      {
        stdio: 'inherit',
      },
    )
  } catch {
    // The report already reached stdout.
  }
  process.exit(FAILURE_EXIT_CODE)
}

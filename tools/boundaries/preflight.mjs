import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { satisfies } from 'semver'

const DEPENDENCY_CRUISER_ENTRY = 'node_modules/dependency-cruiser'
const DEPENDENCY_CRUISER_META = './meta.cjs'
const TRANSPILER = 'typescript'
const NO_TRANSPILER = 'none'

/**
 * dependency-cruiser resolves the transpiler from its own directory, so the
 * check asks from there too — the project root holds a different one.
 */
export function readTranspilerState() {
  const ownDirectory = realpathSync(DEPENDENCY_CRUISER_ENTRY)
  const requireFromCruiser = createRequire(`${ownDirectory}/src/entry.mjs`)
  const meta = requireFromCruiser(DEPENDENCY_CRUISER_META)

  let resolvedVersion = null
  try {
    resolvedVersion = requireFromCruiser(`${TRANSPILER}/package.json`).version
  } catch {
    resolvedVersion = null
  }

  return { resolvedVersion, supportedRange: meta.supportedTranspilers[TRANSPILER] }
}

/**
 * Outside the range, dependency-cruiser skips every TypeScript file and exits
 * 0: a green run that checked nothing (ARCHITECTURE.md §4).
 */
export function assertTranspilerSupported(resolvedVersion, supportedRange) {
  if (resolvedVersion !== null && satisfies(resolvedVersion, supportedRange)) return

  throw new Error(
    `dependency-cruiser needs typescript@${supportedRange} and resolves ` +
      `${resolvedVersion ?? NO_TRANSPILER}. It would cruise zero modules and exit 0. ` +
      'Check the `packageExtensions` block in pnpm-workspace.yaml.',
  )
}

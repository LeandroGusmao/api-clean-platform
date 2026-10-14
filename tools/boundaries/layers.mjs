/**
 * The boundary table of ARCHITECTURE.md §2, expressed once.
 *
 * Both consumers read from here: `.dependency-cruiser.mjs` (the gate) and the
 * `architecture-audit` scanner (the review net). Patterns are strings, not
 * RegExp, because dependency-cruiser takes them as strings.
 */
export const PURE =
  '^src/(shared/|modules/[^/]+/(entities|value-objects|repositories|ports|use-cases|services|dtos|errors|emails)/|modules/[^/]+/config\\.ts$)'
export const MODULE_INFRA = '^src/modules/[^/]+/infra/'
export const GLOBAL_INFRA = '^src/infra/'
export const COMPOSITION = '^(src/main/|src/modules/[^/]+/container\\.ts$)'
export const TEST = '(\\.spec\\.ts$|^tests/|/fixtures/|/in-memory/)'

export const UNCLASSIFIED = 'unknown'

const ELEMENTS = [
  // `test` comes first: a `.spec.ts` inside `use-cases/` is a test, not pure.
  // The order IS the precedence of ARCHITECTURE.md §2.
  ['test', TEST],
  ['composition', COMPOSITION],
  ['module-infra', MODULE_INFRA],
  ['pure', PURE],
  ['global-infra', GLOBAL_INFRA],
]

/** @param {string} filePath repo-relative, POSIX separators. */
export function classify(filePath) {
  for (const [element, pattern] of ELEMENTS) {
    if (new RegExp(pattern).test(filePath)) return element
  }
  return UNCLASSIFIED
}

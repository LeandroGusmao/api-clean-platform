import { classify, UNCLASSIFIED } from './layers.mjs'

/**
 * The only check that catches every silent-failure mode of §4 at once — and,
 * unlike `totalCruised > 0`, it also catches a partial loss.
 */
export function assertEveryFileCruised(cruisedSources, filesOnDisk) {
  const cruised = new Set(cruisedSources)
  const missing = filesOnDisk.filter((file) => !cruised.has(file))
  if (missing.length === 0) return

  throw new Error(
    `${missing.length} file(s) on disk never reached the dependency graph, ` +
      `so no rule was applied to them:\n  ${missing.join('\n  ')}`,
  )
}

/**
 * The gate's version of the scanner's LAYER-UNKNOWN: a production file that no
 * element of §2 classifies is a file no rule constrains.
 *
 * It reads the module list, not the dependency list: a file with no imports at
 * all never shows up on the `from` side of a dependency and would escape a
 * dependency-cruiser rule.
 */
export function assertEveryFileClassified(cruisedSources) {
  const unclassified = cruisedSources.filter(
    (source) => classify(source) === UNCLASSIFIED,
  )
  if (unclassified.length === 0) return

  throw new Error(
    `${unclassified.length} production file(s) match no element of the §2 table, ` +
      `so no boundary rule applies to them:\n  ${unclassified.join('\n  ')}`,
  )
}

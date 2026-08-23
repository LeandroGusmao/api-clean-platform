import type { FastifySchemaValidationError } from 'fastify'

const INVALID_VALUE_CODE = 'INVALID_VALUE'

/**
 * Zod issue codes that describe how the schema is composed rather than what is
 * wrong with the data. `custom` leaks that a `.refine()` exists, `invalid_union`
 * that a `z.union()` does — neither means anything to a client, so they are not
 * published.
 */
const SCHEMA_INTERNAL_CODES = new Set([
  'custom',
  'invalid_union',
  'invalid_key',
  'invalid_element',
])

const PATH_SEPARATOR = '/'
const FIELD_SEPARATOR = '.'

export interface ValidationDetail {
  field?: string
  code: string
}

function toFieldPath(instancePath: string): string {
  return instancePath
    .split(PATH_SEPARATOR)
    .filter((segment) => segment.length > 0)
    .join(FIELD_SEPARATOR)
}

/**
 * The published code is Zod's own issue code, upper-cased — not a translation
 * table. A table would be an identity function written by hand, and its
 * fallback would quietly turn "Zod renamed a code" into INVALID_VALUE.
 *
 * What guards the contract instead is the vocabulary test in
 * `error-handler.spec.ts`: it drives a real payload through real Zod and pins
 * every code, so an upgrade that renames an issue fails loudly.
 */
function toContractCode(issue: FastifySchemaValidationError): string {
  return SCHEMA_INTERNAL_CODES.has(issue.keyword)
    ? INVALID_VALUE_CODE
    : issue.keyword.toUpperCase()
}

export function toValidationDetails(
  issues: readonly FastifySchemaValidationError[],
): ValidationDetail[] {
  return issues.map((issue) => {
    const field = toFieldPath(issue.instancePath)
    const code = toContractCode(issue)

    // `exactOptionalPropertyTypes` is on: the key is omitted, never set to
    // undefined. An empty path means the body as a whole is wrong.
    return field.length > 0 ? { field, code } : { code }
  })
}

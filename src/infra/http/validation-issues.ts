import type { FastifySchemaValidationError } from 'fastify'

/** Issue codes as Zod 4 emits them. */
const ZOD_INVALID_TYPE = 'invalid_type'
const ZOD_TOO_SMALL = 'too_small'
const ZOD_TOO_BIG = 'too_big'
const ZOD_INVALID_FORMAT = 'invalid_format'
const ZOD_NOT_MULTIPLE_OF = 'not_multiple_of'
const ZOD_UNRECOGNIZED_KEYS = 'unrecognized_keys'

/**
 * Codes as the API publishes them. They are NOT the Zod codes: the client
 * branches on these, so they are ours to keep stable across Zod upgrades.
 */
export const INVALID_TYPE_CODE = 'INVALID_TYPE'
export const TOO_SHORT_CODE = 'TOO_SHORT'
export const TOO_SMALL_CODE = 'TOO_SMALL'
export const TOO_LONG_CODE = 'TOO_LONG'
export const TOO_LARGE_CODE = 'TOO_LARGE'
export const INVALID_FORMAT_CODE = 'INVALID_FORMAT'
export const NOT_MULTIPLE_OF_CODE = 'NOT_MULTIPLE_OF'
export const UNRECOGNIZED_KEYS_CODE = 'UNRECOGNIZED_KEYS'
export const INVALID_VALUE_CODE = 'INVALID_VALUE'

const ORIGIN_PARAM = 'origin'
/** Origins whose size is a length, so "too small" reads as "too short". */
const LENGTH_ORIGINS = new Set(['string', 'array', 'set', 'file'])

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

function hasLengthOrigin(params: Record<string, unknown>): boolean {
  const origin = params[ORIGIN_PARAM]
  return typeof origin === 'string' && LENGTH_ORIGINS.has(origin)
}

function toContractCode(issue: FastifySchemaValidationError): string {
  switch (issue.keyword) {
    case ZOD_INVALID_TYPE:
      return INVALID_TYPE_CODE
    case ZOD_TOO_SMALL:
      return hasLengthOrigin(issue.params) ? TOO_SHORT_CODE : TOO_SMALL_CODE
    case ZOD_TOO_BIG:
      return hasLengthOrigin(issue.params) ? TOO_LONG_CODE : TOO_LARGE_CODE
    case ZOD_INVALID_FORMAT:
      return INVALID_FORMAT_CODE
    case ZOD_NOT_MULTIPLE_OF:
      return NOT_MULTIPLE_OF_CODE
    case ZOD_UNRECOGNIZED_KEYS:
      return UNRECOGNIZED_KEYS_CODE
    default:
      // Anything unnamed above — `custom`, and whatever a future Zod adds —
      // becomes INVALID_VALUE. Without this, a Zod upgrade could put
      // `undefined` into a public contract.
      return INVALID_VALUE_CODE
  }
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

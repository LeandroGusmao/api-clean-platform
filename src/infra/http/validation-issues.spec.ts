import type { FastifySchemaValidationError } from 'fastify'
import { describe, expect, it } from 'vitest'
import { toValidationDetails } from '#infra/http/validation-issues'

const STRING_ORIGIN = 'string'
const ARRAY_ORIGIN = 'array'
const NUMBER_ORIGIN = 'number'

const EMAIL_PATH = '/email'
const EMAIL_FIELD = 'email'
const NESTED_PATH = '/items/0/email'
const NESTED_FIELD = 'items.0.email'
const ROOT_PATH = '/'

const PASSWORD_PATH = '/password'
const PASSWORD_FIELD = 'password'

function issue(
  keyword: string,
  instancePath: string,
  params: Record<string, unknown> = {},
): FastifySchemaValidationError {
  return { keyword, instancePath, schemaPath: `#${instancePath}/${keyword}`, params }
}

// The normative table from the design spec, one row per case.
const TRANSLATION_TABLE: ReadonlyArray<[string, Record<string, unknown>, string]> = [
  ['invalid_type', {}, 'INVALID_TYPE'],
  ['too_small', { origin: STRING_ORIGIN }, 'TOO_SHORT'],
  ['too_small', { origin: ARRAY_ORIGIN }, 'TOO_SHORT'],
  ['too_small', { origin: NUMBER_ORIGIN }, 'TOO_SMALL'],
  ['too_big', { origin: STRING_ORIGIN }, 'TOO_LONG'],
  ['too_big', { origin: ARRAY_ORIGIN }, 'TOO_LONG'],
  ['too_big', { origin: NUMBER_ORIGIN }, 'TOO_LARGE'],
  ['invalid_format', {}, 'INVALID_FORMAT'],
  ['not_multiple_of', {}, 'NOT_MULTIPLE_OF'],
  ['unrecognized_keys', {}, 'UNRECOGNIZED_KEYS'],
  ['custom', {}, 'INVALID_VALUE'],
  ['a_code_a_future_zod_version_adds', {}, 'INVALID_VALUE'],
]

describe('toValidationDetails', () => {
  it.each(TRANSLATION_TABLE)(
    'translates %s with params %o into %s',
    (keyword, params, expected) => {
      const details = toValidationDetails([issue(keyword, EMAIL_PATH, params)])

      expect(details).toEqual([{ field: EMAIL_FIELD, code: expected }])
    },
  )

  it('flattens a nested path into a dotted field', () => {
    const details = toValidationDetails([issue('invalid_type', NESTED_PATH)])

    expect(details).toEqual([{ field: NESTED_FIELD, code: 'INVALID_TYPE' }])
  })

  it('omits the field when the issue points at the whole body', () => {
    // `unrecognized_keys` arrives with an empty path: the object is wrong, not
    // one of its fields. Verified against Zod 4.4.3.
    const details = toValidationDetails([issue('unrecognized_keys', ROOT_PATH)])

    expect(details).toEqual([{ code: 'UNRECOGNIZED_KEYS' }])
    expect(details[0]).not.toHaveProperty('field')
  })

  it('preserves order across several issues', () => {
    const details = toValidationDetails([
      issue('invalid_format', EMAIL_PATH),
      issue('too_small', PASSWORD_PATH, { origin: STRING_ORIGIN }),
    ])

    expect(details).toEqual([
      { field: EMAIL_FIELD, code: 'INVALID_FORMAT' },
      { field: PASSWORD_FIELD, code: 'TOO_SHORT' },
    ])
  })
})

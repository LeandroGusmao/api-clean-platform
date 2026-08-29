import type { FastifySchemaValidationError } from 'fastify'
import { describe, expect, it } from 'vitest'
import { toValidationDetails } from '#infra/http/errors/validation-issues'

const EMAIL_PATH = '/email'
const EMAIL_FIELD = 'email'
const NESTED_PATH = '/items/0/email'
const NESTED_FIELD = 'items.0.email'
const ROOT_PATH = '/'

const PASSWORD_PATH = '/password'
const PASSWORD_FIELD = 'password'

const INVALID_VALUE_CODE = 'INVALID_VALUE'

function issue(
  keyword: string,
  instancePath: string,
  params: Record<string, unknown> = {},
): FastifySchemaValidationError {
  return { keyword, instancePath, schemaPath: `#${instancePath}/${keyword}`, params }
}

describe('toValidationDetails — code', () => {
  it.each([
    ['invalid_type', 'INVALID_TYPE'],
    ['too_small', 'TOO_SMALL'],
    ['too_big', 'TOO_BIG'],
    ['invalid_format', 'INVALID_FORMAT'],
    ['not_multiple_of', 'NOT_MULTIPLE_OF'],
    ['unrecognized_keys', 'UNRECOGNIZED_KEYS'],
    ['invalid_value', 'INVALID_VALUE'],
  ])('publishes %s as %s', (keyword, expected) => {
    expect(toValidationDetails([issue(keyword, EMAIL_PATH)])).toEqual([
      { field: EMAIL_FIELD, code: expected },
    ])
  })

  it.each(['custom', 'invalid_union', 'invalid_key', 'invalid_element'])(
    'collapses %s, which describes the schema rather than the data',
    (keyword) => {
      expect(toValidationDetails([issue(keyword, EMAIL_PATH)])).toEqual([
        { field: EMAIL_FIELD, code: INVALID_VALUE_CODE },
      ])
    },
  )

  it('passes a code a future Zod may add straight through', () => {
    // Deliberate: an unknown code reaches the client as itself rather than
    // being flattened into INVALID_VALUE, which would hide the change.
    expect(toValidationDetails([issue('sideways_vector', EMAIL_PATH)])).toEqual([
      { field: EMAIL_FIELD, code: 'SIDEWAYS_VECTOR' },
    ])
  })

  it('ignores the issue origin', () => {
    // `params.origin` is Zod internals and the type explicitly allows values
    // outside its own union. A short string and a small number are both
    // TOO_SMALL; the client already knows the field's type.
    const details = toValidationDetails([
      issue('too_small', PASSWORD_PATH, { origin: 'string' }),
      issue('too_small', EMAIL_PATH, { origin: 'number' }),
    ])

    expect(details).toEqual([
      { field: PASSWORD_FIELD, code: 'TOO_SMALL' },
      { field: EMAIL_FIELD, code: 'TOO_SMALL' },
    ])
  })
})

describe('toValidationDetails — field', () => {
  it('flattens a nested path into a dotted field', () => {
    expect(toValidationDetails([issue('invalid_type', NESTED_PATH)])).toEqual([
      { field: NESTED_FIELD, code: 'INVALID_TYPE' },
    ])
  })

  it('omits the field when the issue points at the whole body', () => {
    const details = toValidationDetails([issue('unrecognized_keys', ROOT_PATH)])

    expect(details).toEqual([{ code: 'UNRECOGNIZED_KEYS' }])
    expect(details[0]).not.toHaveProperty('field')
  })

  it('preserves order across several issues', () => {
    const details = toValidationDetails([
      issue('invalid_format', EMAIL_PATH),
      issue('too_small', PASSWORD_PATH),
    ])

    expect(details).toEqual([
      { field: EMAIL_FIELD, code: 'INVALID_FORMAT' },
      { field: PASSWORD_FIELD, code: 'TOO_SMALL' },
    ])
  })
})

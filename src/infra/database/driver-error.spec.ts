import { describe, expect, it } from 'vitest'
import {
  findDriverError,
  type PersistenceError,
  toPersistenceError,
} from '#infra/database/driver-error'

// A realistic argon2id digest. If any assertion below finds this string in the
// converted error, a password hash reached code that is allowed to log.
const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$U0FMVFNBTFQ$REALDIGESTVALUE'
const EMAIL = 'joao@example.com'
const QUERY = 'insert into "users" ("id","email","password_hash") values ($1,$2,$3)'

const UNIQUE_VIOLATION = '23505'
const PKEY_CONSTRAINT = 'users_pkey'
const DRIVER_MESSAGE = 'duplicate key value violates unique constraint "users_pkey"'
// Postgres puts the conflicting VALUE in `detail`, never in `message`. It must
// not survive the conversion.
const DRIVER_DETAIL = `Key (email)=(${EMAIL}) already exists.`

const CONNECTION_MESSAGE = 'connection terminated unexpectedly'

/**
 * Shaped like `drizzle-orm`'s `DrizzleQueryError`: the message glues the query
 * to every bound parameter, `params` is an enumerable own property, and the
 * driver error sits in `cause`. Built by hand rather than imported so the test
 * pins the shape we defend against, not whatever the current version happens to
 * produce.
 */
function makeQueryError(cause?: unknown): Error {
  const error = new Error(
    `Failed query: ${QUERY}\nparams: 0f1c8a2e,${EMAIL},${PASSWORD_HASH}`,
  )
  error.name = 'DrizzleQueryError'
  Object.assign(error, { query: QUERY, params: ['0f1c8a2e', EMAIL, PASSWORD_HASH] })
  if (cause !== undefined) error.cause = cause

  return error
}

function makeDriverError(): Error {
  return Object.assign(new Error(DRIVER_MESSAGE), {
    code: UNIQUE_VIOLATION,
    constraint: PKEY_CONSTRAINT,
    detail: DRIVER_DETAIL,
  })
}

/** Everything a logger could reach: the message, the stack, and every own key. */
function everythingReachable(error: PersistenceError): string {
  return [error.message, error.stack ?? '', JSON.stringify({ ...error })].join('\n')
}

describe('toPersistenceError', () => {
  it('carries no bound parameter in anything a logger can read', () => {
    const converted = toPersistenceError(makeQueryError(makeDriverError()))

    expect(everythingReachable(converted)).not.toContain(PASSWORD_HASH)
  })

  it('drops the conflicting value Postgres puts in `detail`', () => {
    const converted = toPersistenceError(makeQueryError(makeDriverError()))

    // An allow-list, not a deny-list: only `message`, `code`, `constraint` and
    // `query` survive, so a field the driver adds later cannot ride along.
    expect(everythingReachable(converted)).not.toContain(DRIVER_DETAIL)
  })

  it('keeps no cause, so nothing downstream can concatenate the original', () => {
    const converted = toPersistenceError(makeQueryError(makeDriverError()))

    expect(converted.cause).toBeUndefined()
  })

  it('keeps what a diagnosis needs', () => {
    const converted = toPersistenceError(makeQueryError(makeDriverError()))

    expect(converted.message).toBe(DRIVER_MESSAGE)
    expect(converted.code).toBe(UNIQUE_VIOLATION)
    expect(converted.constraint).toBe(PKEY_CONSTRAINT)
    expect(converted.query).toBe(QUERY)
  })

  it('takes the message from the driver, never from the wrapper', () => {
    const converted = toPersistenceError(makeQueryError(makeDriverError()))

    // The wrapper's message is the one carrying the parameters.
    expect(converted.message).not.toContain('Failed query')
  })

  it('handles a driver error with no code, such as a dropped connection', () => {
    const converted = toPersistenceError(makeQueryError(new Error(CONNECTION_MESSAGE)))

    expect(converted.message).toBe(CONNECTION_MESSAGE)
    expect(converted.code).toBeUndefined()
    expect(converted.query).toBe(QUERY)
  })

  it('passes through an error that never touched the driver', () => {
    const converted = toPersistenceError(new Error(CONNECTION_MESSAGE))

    expect(converted.message).toBe(CONNECTION_MESSAGE)
    expect(converted.query).toBeUndefined()
  })

  it('survives a self-referencing cause', () => {
    const error = makeQueryError()
    error.cause = error

    expect(() => toPersistenceError(error)).not.toThrow()
    expect(everythingReachable(toPersistenceError(error))).not.toContain(PASSWORD_HASH)
  })

  it('survives a mutually cyclic cause', () => {
    const wrapper = new Error('wrapper')
    const error = makeQueryError(wrapper)
    wrapper.cause = error

    expect(() => toPersistenceError(error)).not.toThrow()
    expect(everythingReachable(toPersistenceError(error))).not.toContain(PASSWORD_HASH)
  })

  it('falls back to a generic message when every node is parameter-bearing', () => {
    const converted = toPersistenceError(makeQueryError())

    // Nothing safe to quote: the only message in the chain is the wrapper's.
    expect(converted.message).not.toContain(PASSWORD_HASH)
    expect(converted.message.length).toBeGreaterThan(0)
  })

  it('does not throw on a non-object', () => {
    expect(() => toPersistenceError('boom')).not.toThrow()
    expect(() => toPersistenceError(null)).not.toThrow()
  })
})

describe('findDriverError', () => {
  it('finds the driver error underneath the query wrapper', () => {
    const found = findDriverError(makeQueryError(makeDriverError()))

    expect(found?.code).toBe(UNIQUE_VIOLATION)
    expect(found?.constraint).toBe(PKEY_CONSTRAINT)
  })

  it('returns undefined when nothing in the chain carries a driver code', () => {
    expect(findDriverError(makeQueryError(new Error(CONNECTION_MESSAGE)))).toBeUndefined()
  })

  it('returns undefined for a non-object', () => {
    expect(findDriverError('boom')).toBeUndefined()
  })

  it('terminates on a cyclic cause', () => {
    const error = makeQueryError()
    error.cause = error

    expect(() => findDriverError(error)).not.toThrow()
  })
})

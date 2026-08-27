import pino from 'pino'

/**
 * A structural match for a parameter-bearing query error — `drizzle-orm`'s
 * `DrizzleQueryError` is the motivating example, but this is not specific to it.
 */
interface ParameterBearingError {
  message: string
  params: unknown
  query?: unknown
  cause?: unknown
  name?: unknown
}

const UNKNOWN_QUERY_TEXT = '<query text unavailable>'
const UNKNOWN_ERROR_TYPE = 'Error'

/**
 * Depth cap on the `cause`-chain walk performed while serializing. Mirrors
 * `drizzle-users-repository.ts`'s `MAX_CAUSE_DEPTH`, and for the same reason
 * stated there: we do not control the shape of the error we are handed, so a
 * self-referencing or mutually cyclic `cause` must not be able to recurse
 * forever. Unlike that walk, this one cannot just stop and return `false` —
 * it must still produce a log line — so past the cap the nested cause is
 * replaced with a truncation marker instead of continuing.
 */
const MAX_CAUSE_SERIALIZATION_DEPTH = 10
const CAUSE_TRUNCATED_MARKER = '<cause chain truncated: exceeded depth limit>'

/** The shape every custom `serializers.err` function must return. */
interface SerializedLogError {
  type: string
  message: string
  stack: string
  [key: string]: unknown
}

/**
 * Duck-typed on `params`, not `instanceof DrizzleQueryError`: this module has
 * no business depending on the ORM, and under pnpm a duplicated module
 * instance would make `instanceof` fail silently — turning this guard off
 * without any error. Broader than one class name on purpose: a future ORM
 * version that renames the class should not silently reopen the hole, and any
 * other error shaped like this one deserves the same treatment.
 *
 * Checked with `Object.hasOwn`, not the `in` operator: `in` also matches a
 * `params` exposed through the prototype chain (e.g. a class with a `get
 * params()`), and firing on an unrelated error is not harmless — it replaces
 * the real `message` with a placeholder and drops the real `stack` entirely.
 */
function isParameterBearingError(err: unknown): err is ParameterBearingError {
  if (typeof err !== 'object' || err === null || !Object.hasOwn(err, 'params')) {
    return false
  }

  return typeof (err as Record<string, unknown>).message === 'string'
}

/**
 * `DrizzleQueryError.message` is not just the query text: it is
 * `Failed query: ${query}\nparams: ${params}`, and one of those bound
 * parameters can be the argon2 password hash or the registrant's email.
 * `params` is an enumerable own property, and the default stack embeds the
 * same message — so `message`, `stack` and `params` are three separate
 * carriers of the same leak, and all three must be handled here.
 *
 * The query text alone (`error.query`) is safe: its `$1, $2` placeholders
 * carry no values. The original `stack` is discarded entirely — a log
 * serializer must still return a `stack` string, so this one reuses the same
 * sanitized message rather than keep any part of the original, which points
 * into ORM internals and embeds the same leak this function exists to close.
 * The `cause` (the driver error underneath) is kept through pino's own
 * serializer, so `code` and `constraint` — what a diagnosis actually needs —
 * survive; the request's `traceId` covers the rest.
 */
function serializeParameterBearingError(
  err: ParameterBearingError,
  depth: number,
): SerializedLogError {
  const message = typeof err.query === 'string' ? err.query : UNKNOWN_QUERY_TEXT
  const type = typeof err.name === 'string' ? err.name : UNKNOWN_ERROR_TYPE

  return {
    type,
    message,
    stack: message,
    ...(err.cause === undefined ? {} : { cause: serializeCause(err.cause, depth) }),
  }
}

/**
 * Recurses through `serializeError` rather than calling
 * `pino.stdSerializers.err` on the cause directly: for the ordinary case (the
 * `pg` driver error, which is not parameter-bearing) the result is identical,
 * and the extra step also sanitizes a hypothetical nested parameter-bearing
 * cause instead of re-exposing it. `depth` is what keeps that recursion from
 * running forever on a self-referencing or mutually cyclic `cause` — see
 * `MAX_CAUSE_SERIALIZATION_DEPTH`.
 */
function serializeCause(cause: unknown, depth: number): unknown {
  if (depth >= MAX_CAUSE_SERIALIZATION_DEPTH) return CAUSE_TRUNCATED_MARKER

  return serializeError(cause, depth + 1)
}

/**
 * The `err` serializer wired into `buildServer`'s logger. Covers a
 * parameter-bearing error thrown directly, and its `cause` chain downward
 * from there — every repository that raises one is covered without
 * remembering to sanitize it by hand at each call site.
 *
 * It does NOT cover a parameter-bearing error nested *beneath* a plain
 * wrapper. Anything that is not parameter-bearing at the top delegates
 * straight to pino's own `stdSerializers.err`, unchanged — and that
 * serializer concatenates the whole `cause` chain into the wrapper's own
 * `message` and `stack`. The same is true of `AggregateError.errors` and of
 * any own property whose value looks like an error: pino walks those too, and
 * this function does not.
 *
 * **This is the second layer, not the first.** The first is
 * `infra/database/driver-error.ts`: a repository converts what the driver
 * threw before re-throwing it, so the parameter-bearing object never leaves
 * `infra/` and no caller can nest what it never received. Containment at the
 * log would have to anticipate every position an error can hide in;
 * prevention at the source has one place to get right.
 *
 * What is left here covers the case a repository misses — a raw driver error
 * reaching the logger at the top level.
 */
export function serializeError(err: unknown, depth = 0): SerializedLogError {
  if (isParameterBearingError(err)) return serializeParameterBearingError(err, depth)

  return pino.stdSerializers.err(err as Error)
}

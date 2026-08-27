/**
 * Depth cap on the `cause`-chain walk. We do not control the shape of the error
 * the driver hands us, so a self-referencing or mutually cyclic `cause` must not
 * be able to spin forever. Nothing Drizzle throws nests anywhere near this deep.
 */
const MAX_CAUSE_DEPTH = 10

const PERSISTENCE_ERROR_NAME = 'PersistenceError'
const UNKNOWN_FAILURE_MESSAGE = 'the database rejected the statement'

/** The properties of a driver error that are safe to carry outward. */
export interface DriverErrorDetails {
  /** SQLSTATE, e.g. `23505` for a unique violation. */
  code: string
  /** The constraint the statement violated, when the failure names one. */
  constraint: string | undefined
}

/**
 * A database failure, stripped of everything that could carry a value.
 *
 * Deliberately **not** an `AppError`: an unexpected persistence failure is not
 * one of the six semantic categories, so it falls through to the error
 * handler's generic branch and answers 500 — which is what it is.
 *
 * It carries **no `cause`**. That is the point of the whole type: pino's error
 * serializer concatenates a cause chain into the parent's message and stack, so
 * an error holding the original would leak it again from a nested position.
 */
export class PersistenceError extends Error {
  readonly code: string | undefined
  readonly constraint: string | undefined
  /** The statement text, with its `$1, $2` placeholders. Never the values. */
  readonly query: string | undefined

  constructor(
    message: string,
    details: {
      code?: string | undefined
      constraint?: string | undefined
      query?: string | undefined
    } = {},
  ) {
    super(message)
    this.name = PERSISTENCE_ERROR_NAME
    this.code = details.code
    this.constraint = details.constraint
    this.query = details.query
  }
}

/**
 * An error that glues bound parameters into its own message.
 *
 * Recognised by `params` rather than by class, for two reasons: this module has
 * no business importing the ORM, and under pnpm a duplicated module instance
 * would make `instanceof` fail silently — turning the guard off with no error.
 */
function isParameterBearing(node: object): boolean {
  return Object.hasOwn(node, 'params')
}

function readString(node: object, key: string): string | undefined {
  const value = (node as Record<string, unknown>)[key]

  return typeof value === 'string' ? value : undefined
}

/**
 * Walks the `cause` chain from `error` down, calling `visit` on each node.
 * Bounded by {@link MAX_CAUSE_DEPTH}, so a cyclic chain terminates.
 */
function walkCauseChain(error: unknown, visit: (node: object) => void): void {
  let current: unknown = error

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return

    visit(current)

    current = 'cause' in current ? current.cause : undefined
  }
}

/**
 * The driver error underneath whatever wrapped it, identified by carrying a
 * SQLSTATE `code`. Returns `undefined` when the failure never reached the
 * server — a dropped connection, for instance, has no code.
 *
 * Repositories use this to classify a failure (translating a specific
 * constraint violation into a domain error) before falling back to
 * {@link toPersistenceError}.
 */
export function findDriverError(error: unknown): DriverErrorDetails | undefined {
  let found: DriverErrorDetails | undefined

  walkCauseChain(error, (node) => {
    if (found !== undefined) return

    const code = readString(node, 'code')
    if (code === undefined) return

    found = { code, constraint: readString(node, 'constraint') }
  })

  return found
}

/**
 * Converts whatever the driver threw into an error that is safe to log.
 *
 * This is the seam that keeps a password hash out of the logs. Drizzle's
 * `DrizzleQueryError` builds its message as
 * `Failed query: ${query}\nparams: ${params}` — so the message, the stack it
 * derives from, and the enumerable `params` property are three separate
 * carriers of every bound value, and an `INSERT` into `users` binds the argon2
 * hash. Sanitising at the log is not enough, because an error nested under a
 * wrapper reaches the logger through the wrapper's own concatenated message.
 * So the dangerous object stops here and never leaves `infra/`.
 *
 * **What survives is an allow-list, not a deny-list.** Copying everything
 * except `params` would carry Postgres's `detail` along, and `detail` embeds
 * the conflicting value: `Key (email)=(joao@example.com) already exists.`
 * With an allow-list, a field the driver adds in a later version cannot ride
 * along by accident.
 *
 * The message is taken from the deepest node that is not parameter-bearing —
 * the driver's own description of the failure (`duplicate key value violates…`,
 * `connection terminated unexpectedly`), which is the half worth reading.
 */
export function toPersistenceError(error: unknown): PersistenceError {
  let message: string | undefined
  let query: string | undefined
  let code: string | undefined
  let constraint: string | undefined

  walkCauseChain(error, (node) => {
    query ??= readString(node, 'query')

    const nodeCode = readString(node, 'code')
    if (code === undefined && nodeCode !== undefined) {
      code = nodeCode
      constraint = readString(node, 'constraint')
    }

    // Later nodes overwrite earlier ones on purpose: the deepest safe message
    // is the driver's, and the shallowest is the wrapper's.
    if (!isParameterBearing(node)) {
      message = readString(node, 'message') ?? message
    }
  })

  return new PersistenceError(message ?? UNKNOWN_FAILURE_MESSAGE, {
    code,
    constraint,
    query,
  })
}

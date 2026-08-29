import type { FastifyRequest, preHandlerHookHandler } from 'fastify'
import { UnauthorizedError } from '#shared/errors/app-error'

const BEARER_PREFIX = 'Bearer '
const INVALID_ACCESS_TOKEN_CODE = 'INVALID_ACCESS_TOKEN'
const INVALID_ACCESS_TOKEN_MESSAGE = 'Invalid or expired access token'
const UNGUARDED_ROUTE_MESSAGE =
  'getPrincipal called on a route registered without the auth guard'

/** The authenticated caller, as the guard learned it from the token. */
export interface Principal {
  id: string
}

/**
 * Injected, which is the whole point: this file knows nothing about the auth
 * module, so no module has to import `auth` in order to protect its routes.
 */
export type VerifyAccessToken = (token: string) => Promise<{ sub: string }>

/**
 * Extends `UnauthorizedError`, not `AppError` directly: the error handler
 * branches on the six categories and treats an `AppError` outside them as a
 * programming mistake, answering 500.
 */
export class InvalidAccessTokenError extends UnauthorizedError {
  readonly code = INVALID_ACCESS_TOKEN_CODE

  constructor() {
    super(INVALID_ACCESS_TOKEN_MESSAGE)
  }
}

/**
 * The guard is the only writer in the system: this map is not exported, so
 * forging a principal would require importing something that does not exist.
 *
 * The alternative — `declare module 'fastify'` with `request.user` — is an
 * ambient global type that would let any handler of any module assign
 * `request.user = { id: request.body.userId }` and still compile, reached by
 * property access rather than by import, where no boundary lint can see it.
 */
const principals = new WeakMap<FastifyRequest, Principal>()

export function makeAuthGuard(verify: VerifyAccessToken): preHandlerHookHandler {
  return async (request) => {
    const header = request.headers.authorization

    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      throw new InvalidAccessTokenError()
    }

    const token = header.slice(BEARER_PREFIX.length)

    // A bare "Bearer " with nothing after it still starts with the prefix, so
    // an empty token must be rejected here — otherwise a permissive verifier
    // (or a verifier not yet checking for emptiness) could turn a missing
    // credential into a "valid" one.
    if (token.length === 0) {
      throw new InvalidAccessTokenError()
    }

    let subject: string
    try {
      ;({ sub: subject } = await verify(token))
    } catch {
      // Swallowed on purpose: the library's message must not reach the client,
      // and a missing header, a forged token and an expired one are one single
      // state to a client that knows what it sent.
      throw new InvalidAccessTokenError()
    }

    principals.set(request, { id: subject })
  }
}

/**
 * Only reachable when a route was registered without the guard — a wiring
 * mistake, not a credential failure. A plain `Error` on purpose: it lands in the
 * error handler's generic branch, so the mistake is LOGGED as a 500 with its
 * traceId instead of answering 401 and reading like ordinary expired-token
 * traffic. The client still sees only the generic body.
 */
export function getPrincipal(request: FastifyRequest): Principal {
  const principal = principals.get(request)
  if (principal === undefined) throw new Error(UNGUARDED_ROUTE_MESSAGE)

  return principal
}

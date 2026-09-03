import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { getPrincipal } from '#infra/http/auth-guard'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import { BEARER_SECURITY_SCHEME } from '#infra/http/openapi'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  NO_CONTENT_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import { clearRefreshCookie } from '#modules/auth/infra/http/refresh-cookie'

const LOGOUT_ALL_PATH = '/logout-all'
const LOGOUT_ALL_SUMMARY = 'End every session of this account'
const LOGOUT_ALL_DESCRIPTION =
  'Revokes every refresh token of the authenticated user, on every device. ' +
  'Access tokens already issued stay valid until they expire — decision 11 ' +
  'keeps the database out of the authenticated path, so revocation latency is ' +
  'the access token TTL.'

/**
 * No body schema, so no 400: this endpoint reads nothing from the request but
 * the verified token subject. The id NEVER comes from client input — taking a
 * `userId` from the body here would let any authenticated caller sign anyone
 * out.
 */
export const logoutAllRoute: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    LOGOUT_ALL_PATH,
    {
      preHandler: guard,
      schema: {
        tags: [AUTH_TAG],
        summary: LOGOUT_ALL_SUMMARY,
        description: LOGOUT_ALL_DESCRIPTION,
        security: [{ [BEARER_SECURITY_SCHEME]: [] }],
        response: {
          [NO_CONTENT_STATUS]: z.null(),
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.logoutAll.execute(getPrincipal(request).id)

      // Sent unconditionally: if a cookie came with the request, it just died
      // in the database, and leaving it in the browser only produces a
      // confusing 401 on the next refresh.
      clearRefreshCookie(reply)

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
  )
}

import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import { InvalidRefreshTokenError } from '#modules/auth/errors/invalid-refresh-token-error'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  NO_CONTENT_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  clearRefreshCookie,
  readRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'

const LOGOUT_PATH = '/logout'
const LOGOUT_SUMMARY = 'End this session'
const LOGOUT_DESCRIPTION =
  'Revokes the whole family of the presented refresh token, ending this ' +
  'device session and leaving other devices signed in. Idempotent: any token ' +
  'that is presented answers 204, known or not.'

const MIN_TOKEN_LENGTH = 1

const bodySchema = z.object({
  refreshToken: z.string().min(MIN_TOKEN_LENGTH).optional(),
})

export const logoutRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    LOGOUT_PATH,
    {
      schema: {
        tags: [AUTH_TAG],
        summary: LOGOUT_SUMMARY,
        description: LOGOUT_DESCRIPTION,
        body: bodySchema,
        response: {
          // `z.null()` and not an omitted entry: with the Zod type provider a
          // handler may only answer a status the schema declares — verified,
          // anything else is a compile error. The generated document publishes
          // this as a response with no content, which is right for a 204.
          [NO_CONTENT_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const presented = request.body.refreshToken ?? readRefreshCookie(request)

      // No credential at all is 401, mirroring the auth guard. A token that IS
      // presented always answers 204 — valid, unknown, expired or already
      // revoked are indistinguishable, so there is no oracle.
      if (presented === undefined) throw new InvalidRefreshTokenError()

      await container.logout.execute({ refreshToken: presented })

      clearRefreshCookie(reply)

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
  )
}

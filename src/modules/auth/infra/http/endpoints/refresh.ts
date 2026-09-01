import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import { InvalidRefreshTokenError } from '#modules/auth/errors/invalid-refresh-token-error'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  OK_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  readRefreshCookie,
  setRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'

const REFRESH_PATH = '/refresh'
const REFRESH_SUMMARY = 'Rotate the refresh token'
const REFRESH_DESCRIPTION =
  'Exchanges a refresh token for a new access token and a new refresh token. ' +
  'The presented token is spent. Send it in the body, or let the browser send ' +
  'the cookie; the answer comes back on the channel it arrived on. A token ' +
  'presented after it was already spent revokes the whole session family.'

const MIN_TOKEN_LENGTH = 1

/**
 * Optional, because the token may arrive in the cookie instead. A missing
 * credential is answered by the handler as 401, not by the schema as 400: an
 * absent credential is an authentication failure, exactly as it is for a
 * missing `Authorization` header.
 */
const bodySchema = z.object({
  refreshToken: z.string().min(MIN_TOKEN_LENGTH).optional(),
})

const okSchema = z.object({
  accessToken: z.string(),
  /** Absent in cookie mode — see `login.ts` for why this is optional. */
  refreshToken: z.string().optional(),
})

export const refreshRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    REFRESH_PATH,
    {
      schema: {
        tags: [AUTH_TAG],
        summary: REFRESH_SUMMARY,
        description: REFRESH_DESCRIPTION,
        body: bodySchema,
        response: {
          [OK_STATUS]: okSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          // The first 503 in the project. The rotation runs inside a
          // transaction, so a deadlock that survives the runner's retries
          // surfaces here as `TransactionConflictError`.
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Body wins: it is the explicit channel, and the cookie is the ambient
      // one. The answer then follows whichever was actually used.
      const presented = request.body.refreshToken ?? readRefreshCookie(request)

      if (presented === undefined) throw new InvalidRefreshTokenError()

      const { accessToken, refreshToken } = await container.refreshToken.execute({
        refreshToken: presented,
      })

      if (request.body.refreshToken === undefined) {
        setRefreshCookie(reply, refreshToken, container.refreshTokenTtlSeconds)

        return reply.status(OK_STATUS).send({ accessToken })
      }

      return reply.status(OK_STATUS).send({ accessToken, refreshToken })
    },
  )
}

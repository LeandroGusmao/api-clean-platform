import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { buildDeviceContext } from '#infra/http/device-context'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  CONFLICT_STATUS,
  OK_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  REFRESH_TRANSPORT_COOKIE,
  refreshTransportSchema,
  setRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'
import { sessionTokensSchema } from '#modules/auth/infra/http/session-tokens'
import { MAX_PASSWORD_LENGTH } from '#modules/auth/value-objects/password'

const GOOGLE_PATH = '/google'
const GOOGLE_SUMMARY = 'Sign in with Google'
const GOOGLE_DESCRIPTION =
  'Exchanges a Google ID token for a session. If the email already has a ' +
  'password account, answers 409 GOOGLE_LINK_REQUIRES_PASSWORD; resend the ' +
  'same request with `password` set to that account password to link Google ' +
  'and receive the session.'

/** Presence, not policy — like `login`: an account made under any password rule must be linkable. */
const MIN_SUBMITTED_PASSWORD_LENGTH = 1
/** A Google ID token is a ~1-2 KB JWT; the ceiling keeps a 10 MB body from reaching crypto. */
const MAX_ID_TOKEN_LENGTH = 4096

const bodySchema = z
  .object({
    idToken: z.string().min(1).max(MAX_ID_TOKEN_LENGTH),
    password: z
      .string()
      .min(MIN_SUBMITTED_PASSWORD_LENGTH)
      .max(MAX_PASSWORD_LENGTH)
      .optional(),
    refreshTransport: refreshTransportSchema,
  })
  .strict()

export const signInWithGoogleRoute: FastifyPluginAsync<{
  container: AuthContainer
}> = async (app, { container }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    GOOGLE_PATH,
    {
      /**
       * Its own ceiling, like login: the link path of this route carries a
       * password guess. Own numbers, not login's — a field named for one route
       * used by another is a comment that lies.
       */
      config: { rateLimit: container.googleSignInRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: GOOGLE_SUMMARY,
        description: GOOGLE_DESCRIPTION,
        body: bodySchema,
        response: {
          [OK_STATUS]: sessionTokensSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [CONFLICT_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
          // Opens a transaction on the create / link branches.
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accessToken, refreshToken } = await container.signInWithGoogle.execute({
        ...request.body,
        device: buildDeviceContext(request),
      })

      if (request.body.refreshTransport === REFRESH_TRANSPORT_COOKIE) {
        setRefreshCookie(reply, refreshToken, container.refreshTokenTtlSeconds)

        return reply.status(OK_STATUS).send({ accessToken })
      }

      return reply.status(OK_STATUS).send({ accessToken, refreshToken })
    },
  )
}

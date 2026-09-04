import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  EXAMPLE_EMAIL,
  EXAMPLE_PASSWORD,
  OK_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  REFRESH_TRANSPORT_COOKIE,
  refreshTransportSchema,
  setRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'
import { sessionTokensSchema } from '#modules/auth/infra/http/session-tokens'
import { MAX_EMAIL_LENGTH } from '#modules/auth/value-objects/email'
import { MAX_PASSWORD_LENGTH } from '#modules/auth/value-objects/password'

const LOGIN_PATH = '/login'
const LOGIN_SUMMARY = 'Log in'
const LOGIN_DESCRIPTION =
  'Exchanges an email and a password for a short-lived access token, to be ' +
  'sent as `Authorization: Bearer <token>` on protected routes.'

const MIN_SUBMITTED_PASSWORD_LENGTH = 1

/**
 * Presence, not policy. Enforcing the registration rules here would answer 400
 * where the correct answer is 401, telling an attacker the guess failed the
 * RULES rather than the password — and an account created under a looser policy
 * must stay able to log in.
 *
 * The maximum stays for an unrelated reason: without a ceiling, a 10 MB body
 * becomes argon2 over 10 MB.
 */
const bodySchema = z.object({
  email: z
    .string()
    .trim()
    .max(MAX_EMAIL_LENGTH)
    .pipe(z.email())
    .meta({ examples: [EXAMPLE_EMAIL] }),
  password: z
    .string()
    .min(MIN_SUBMITTED_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .meta({ examples: [EXAMPLE_PASSWORD] }),
  /**
   * Which channel carries the refresh token back. `login`, `change-password`
   * and `confirm-email` are the three endpoints with no incoming signal to
   * tell a mobile client from a web one — the others learn it from the
   * request that arrived.
   */
  refreshTransport: refreshTransportSchema,
})

export const loginRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    LOGIN_PATH,
    {
      /**
       * Tighter than the global ceiling, because a request here carries a
       * password guess. It counts requests and not failures, so a legitimate
       * user retrying a typo spends the same budget — which is why the number
       * sits far above human retry.
       *
       * `change-password` carries one too, and declares its own ceiling with
       * its own variables rather than borrowing these.
       */
      config: { rateLimit: container.loginRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: LOGIN_SUMMARY,
        description: LOGIN_DESCRIPTION,
        body: bodySchema,
        response: {
          [OK_STATUS]: sessionTokensSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accessToken, refreshToken } = await container.loginUser.execute(
        request.body,
      )

      if (request.body.refreshTransport === REFRESH_TRANSPORT_COOKIE) {
        setRefreshCookie(reply, refreshToken, container.refreshTokenTtlSeconds)

        return reply.status(OK_STATUS).send({ accessToken })
      }

      return reply.status(OK_STATUS).send({ accessToken, refreshToken })
    },
  )
}

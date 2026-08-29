import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  OK_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
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
  email: z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email()),
  password: z.string().min(MIN_SUBMITTED_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
})

const okSchema = z.object({ accessToken: z.string() })

export const loginRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    LOGIN_PATH,
    {
      schema: {
        tags: [AUTH_TAG],
        summary: LOGIN_SUMMARY,
        description: LOGIN_DESCRIPTION,
        body: bodySchema,
        response: {
          [OK_STATUS]: okSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accessToken } = await container.loginUser.execute(request.body)

      return reply.status(OK_STATUS).send({ accessToken })
    },
  )
}

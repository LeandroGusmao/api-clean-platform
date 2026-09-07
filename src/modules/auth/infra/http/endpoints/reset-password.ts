import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  EXAMPLE_PASSWORD,
  NO_CONTENT_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNPROCESSABLE_ENTITY_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_PATTERN,
} from '#modules/auth/value-objects/password'

const RESET_PASSWORD_PATH = '/password/reset'
const RESET_PASSWORD_SUMMARY = 'Reset a password with a recovery token'
const RESET_PASSWORD_DESCRIPTION =
  'Redeems the token emailed by `forgot`, replaces the password, and revokes ' +
  'every session on every device. Answers 204 with no session: sign in with ' +
  'the new password. One error, `PASSWORD_RESET_FAILED`, for every token ' +
  'failure — unknown, wrong, expired or already used.'

/**
 * Shape only — a base64url string in a generous length band. Whether the token
 * is real, or still usable, is `PASSWORD_RESET_FAILED` territory: one answer for
 * every failure mode. The band is wide because the exact length is an adapter
 * detail (`RandomTokenGenerator` emits base64url of 32 bytes = 43 chars).
 */
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/
const RESET_TOKEN_REASON = 'must be a base64url token'
const EXAMPLE_RESET_TOKEN = 'Yk9wYVF1ZVRva2VuRXhhbXBsZVZhbHVlMTIzNDU2Nzg5'

const bodySchema = z
  .object({
    token: z
      .string()
      .regex(RESET_TOKEN_PATTERN, RESET_TOKEN_REASON)
      .meta({ examples: [EXAMPLE_RESET_TOKEN] }),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH)
      .max(MAX_PASSWORD_LENGTH)
      .regex(PASSWORD_POLICY_PATTERN)
      .meta({ examples: [EXAMPLE_PASSWORD] }),
  })
  .strict()

export const resetPasswordRoute: FastifyPluginAsync<{
  container: AuthContainer
}> = async (app, { container }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    RESET_PASSWORD_PATH,
    {
      /**
       * Its own ceiling, like `forgot`: this route takes a token guess from an
       * anonymous request, so a field named for another route would be a comment
       * that lies.
       */
      config: { rateLimit: container.resetPasswordRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: RESET_PASSWORD_SUMMARY,
        description: RESET_PASSWORD_DESCRIPTION,
        body: bodySchema,
        response: {
          [NO_CONTENT_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNPROCESSABLE_ENTITY_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
          // Opens a transaction to consume the token: a deadlock that survives
          // the runner's retries surfaces as `TransactionConflictError`,
          // exactly like `confirm-email`.
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.resetPassword.execute(request.body)

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
  )
}

import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  ACCEPTED_STATUS,
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  EXAMPLE_EMAIL,
  TOO_MANY_REQUESTS_STATUS,
} from '#modules/auth/infra/http/constants'
import { MAX_EMAIL_LENGTH } from '#modules/auth/value-objects/email'

const FORGOT_PASSWORD_PATH = '/password/forgot'
const FORGOT_PASSWORD_SUMMARY = 'Start password recovery'
const FORGOT_PASSWORD_DESCRIPTION =
  'Emails a single-use reset token to the address if it has an account. Always ' +
  'answers 202, whether or not the address has an account: a status that ' +
  'distinguished the two would let anyone enumerate accounts. An address with ' +
  'no account receives nothing.'

/**
 * `.strict()` so a stale client sending anything else takes a 400 rather than a
 * 202 that silently drops the field. `email` in the same shape `register`
 * validates it: presence and format at the wire, so a malformed address answers
 * 400 with a per-field `details` array before it reaches `Email.create`.
 */
const bodySchema = z
  .object({
    email: z
      .string()
      .trim()
      .max(MAX_EMAIL_LENGTH)
      .pipe(z.email())
      .meta({ examples: [EXAMPLE_EMAIL] }),
  })
  .strict()

export const forgotPasswordRoute: FastifyPluginAsync<{
  container: AuthContainer
}> = async (app, { container }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    FORGOT_PASSWORD_PATH,
    {
      /**
       * Its own ceiling, like `register`: this route sends mail to an arbitrary
       * address from an anonymous request.
       */
      config: { rateLimit: container.forgotPasswordRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: FORGOT_PASSWORD_SUMMARY,
        description: FORGOT_PASSWORD_DESCRIPTION,
        body: bodySchema,
        response: {
          // `z.null()`, not an omitted entry: the Zod type provider only lets a
          // handler answer a status the schema declares. No transaction here,
          // so no 503.
          [ACCEPTED_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.forgotPassword.execute(request.body)

      return reply.status(ACCEPTED_STATUS).send(null)
    },
  )
}

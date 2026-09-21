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

const REGISTER_PATH = '/register'
const REGISTER_SUMMARY = 'Register a new account'
const REGISTER_DESCRIPTION =
  'Starts sign-up for an email address and emails a six-digit verification ' +
  'code. The password is chosen at confirmation, not here. Always answers 202, ' +
  'whether or not the address already had an account: a status that ' +
  'distinguished the two would let anyone enumerate accounts. What differs is ' +
  'the email the address receives.'

/**
 * `.strict()` so a stale client still sending `password` gets a 400 rather than
 * a 202 that silently drops the field it thinks it set. The limit comes from the
 * value object, so the policy has exactly one definition; validating here as
 * well is what gives the client a 400 with a per-field `details` array and
 * publishes the shape in the OpenAPI document.
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

export const registerRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    REGISTER_PATH,
    {
      /**
       * Tighter than the global ceiling, like login — for a different reason.
       * This route sends mail to an arbitrary address from an anonymous request,
       * which makes it a spam amplifier. Its own ceiling, not login's, because a
       * field named for one route and used by another is a comment that lies.
       */
      config: { rateLimit: container.registerRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: REGISTER_SUMMARY,
        description: REGISTER_DESCRIPTION,
        body: bodySchema,
        response: {
          // `z.null()` and not an omitted entry: with the Zod type provider a
          // handler may only answer a status the schema declares.
          //
          // No 409, which would tell an anonymous caller the address has an
          // account; no 503: this route opens no transaction, so no
          // `TransactionConflictError` can reach the wire.
          [ACCEPTED_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.registerUser.execute(request.body)

      return reply.status(ACCEPTED_STATUS).send(null)
    },
  )
}

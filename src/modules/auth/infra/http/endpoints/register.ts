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
  EXAMPLE_PASSWORD,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
} from '#modules/auth/infra/http/constants'
import { MAX_EMAIL_LENGTH } from '#modules/auth/value-objects/email'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_PATTERN,
} from '#modules/auth/value-objects/password'

const REGISTER_PATH = '/register'
const REGISTER_SUMMARY = 'Register a new account'
const REGISTER_DESCRIPTION =
  'Creates an account from an email and a password, and emails a verification ' +
  'code. Always answers 202, whether or not the address already had an account: ' +
  'a status that distinguished the two would let anyone enumerate accounts. What ' +
  'differs is the email the address receives.'

/**
 * The limits come from the value objects, so the policy has exactly one
 * definition. Validating here as well as in the domain is deliberate: this is
 * what gives the client a 400 with a per-field `details` array, and what
 * publishes the policy in the OpenAPI document. The value objects are what
 * keep the use case safe for the non-HTTP entrypoints of decision 10.
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
    .min(MIN_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .regex(PASSWORD_POLICY_PATTERN)
    .meta({ examples: [EXAMPLE_PASSWORD] }),
})

export const registerRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    REGISTER_PATH,
    {
      /**
       * Tighter than the global ceiling, like login — for a different reason.
       * This route now sends mail to an arbitrary address from an anonymous
       * request, which makes it a spam amplifier and a way to burn a stranger's
       * live code. Its own ceiling, not login's, because a field named for one
       * route and used by another is a comment that lies.
       */
      config: { rateLimit: container.registerRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: REGISTER_SUMMARY,
        description: REGISTER_DESCRIPTION,
        body: bodySchema,
        response: {
          // `z.null()` and not an omitted entry: with the Zod type provider a
          // handler may only answer a status the schema declares. See the same
          // note on `logout`.
          //
          // 409 is GONE, and that is the whole slice: `EmailAlreadyInUseError`
          // is still raised by the repository — the unique index is still the
          // authority on uniqueness — it just no longer reaches the wire.
          [ACCEPTED_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
          // New here: registration now opens a transaction, so a deadlock that
          // survives the runner's retries surfaces as `TransactionConflictError`.
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.registerUser.execute(request.body)

      return reply.status(ACCEPTED_STATUS).send(null)
    },
  )
}

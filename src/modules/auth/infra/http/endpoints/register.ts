import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  CONFLICT_STATUS,
  CREATED_STATUS,
  EXAMPLE_EMAIL,
  EXAMPLE_PASSWORD,
  EXAMPLE_USER_ID,
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
  'Creates an account from an email and a password. Issues no session tokens: ' +
  'authenticate through the login endpoint afterwards.'

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

const createdSchema = z.object({ id: z.uuid().meta({ examples: [EXAMPLE_USER_ID] }) })

export const registerRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    REGISTER_PATH,
    {
      schema: {
        tags: [AUTH_TAG],
        summary: REGISTER_SUMMARY,
        description: REGISTER_DESCRIPTION,
        body: bodySchema,
        response: {
          [CREATED_STATUS]: createdSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [CONFLICT_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = await container.registerUser.execute(request.body)

      return reply.status(CREATED_STATUS).send({ id })
    },
  )
}

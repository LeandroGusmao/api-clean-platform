import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { getPrincipal } from '#infra/http/auth-guard'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import { BEARER_SECURITY_SCHEME } from '#infra/http/openapi'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  NOT_FOUND_STATUS,
  OK_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'

const ME_PATH = '/me'
const ME_SUMMARY = 'Get the authenticated user profile'
const ME_DESCRIPTION =
  'Returns the profile of the user the access token was issued for. The id ' +
  'always comes from the token subject, never from client input.'

/**
 * `passwordHash` and `updatedAt` are out: the first for the obvious reason, the
 * second for having no consumer. `emailVerifiedAt` is a reserved seat — always
 * null until the verification slice — and it is published now so the client's
 * shape does not change then.
 */
/**
 * `z.date()` describes what the HANDLER hands the serializer, not what goes on
 * the wire: the serializer accepts a `Date` and emits ISO 8601, and the
 * generated document publishes `type: string, format: date-time` either way.
 * Verified, along with the nullable case.
 *
 * `z.iso.datetime()` would publish the same `format` plus a long `pattern`, and
 * would force every handler to call `.toISOString()` itself — putting the
 * domain's types back into the transport layer for a regex that a response
 * schema has no consumer for.
 */
const userSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  emailVerifiedAt: z.date().nullable(),
  createdAt: z.date(),
})

export const meRoute: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    ME_PATH,
    {
      preHandler: guard,
      schema: {
        tags: [AUTH_TAG],
        summary: ME_SUMMARY,
        description: ME_DESCRIPTION,
        security: [{ [BEARER_SECURITY_SCHEME]: [] }],
        response: {
          [OK_STATUS]: userSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [NOT_FOUND_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Nothing to reshape: the use case answers in the shape the contract
      // publishes, so this layer only decides the status. The compiler checks
      // the result against `userSchema` through the type provider.
      const profile = await container.getUserProfile.execute(getPrincipal(request).id)

      return reply.status(OK_STATUS).send(profile)
    },
  )
}

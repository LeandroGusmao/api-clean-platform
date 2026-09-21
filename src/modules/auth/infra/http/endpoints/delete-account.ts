import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { getPrincipal } from '#infra/http/auth-guard'
import { buildDeviceContext } from '#infra/http/device-context'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import { BEARER_SECURITY_SCHEME } from '#infra/http/openapi'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  EXAMPLE_PASSWORD,
  NO_CONTENT_STATUS,
  NOT_FOUND_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
  UNPROCESSABLE_ENTITY_STATUS,
} from '#modules/auth/infra/http/constants'
import { clearRefreshCookie } from '#modules/auth/infra/http/refresh-cookie'
import { MAX_PASSWORD_LENGTH } from '#modules/auth/value-objects/password'

const DELETE_ACCOUNT_PATH = '/me'
const DELETE_ACCOUNT_SUMMARY = 'Delete this account for good'
const DELETE_ACCOUNT_DESCRIPTION =
  'Deletes the authenticated account and everything tied to it: every ' +
  'session, every linked provider, every password reset token, and any ' +
  'pending registration for the address. Irreversible — there is no grace ' +
  'period and nothing is exported first. An account with a password must ' +
  'present it; an account that only signs in with Google does not, having ' +
  'none — though it still sends a body, an empty JSON object, since a ' +
  'request with no body at all is rejected as malformed. Access tokens ' +
  'already issued stay valid until they expire, with nothing left to ' +
  'reach.'

const MIN_SUBMITTED_PASSWORD_LENGTH = 1

/**
 * `password` checks PRESENCE, not policy — the same call login and the
 * password change make: an account created under a looser policy must stay
 * able to delete itself. It is optional because a federated-only account has
 * none to send, and whether it is actually required is the use case's call,
 * since only it knows whether the account carries a hash. The ceiling stays
 * for the unrelated reason: without one, a 10 MB body becomes argon2 over
 * 10 MB.
 */
const bodySchema = z.object({
  password: z
    .string()
    .min(MIN_SUBMITTED_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .meta({ examples: [EXAMPLE_PASSWORD] })
    .optional(),
})

export const deleteAccountRoute: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  app.withTypeProvider<ZodTypeProvider>().delete(
    DELETE_ACCOUNT_PATH,
    {
      preHandler: guard,
      config: { rateLimit: container.accountDeleteRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: DELETE_ACCOUNT_SUMMARY,
        description: DELETE_ACCOUNT_DESCRIPTION,
        security: [{ [BEARER_SECURITY_SCHEME]: [] }],
        body: bodySchema,
        response: {
          [NO_CONTENT_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [NOT_FOUND_STATUS]: errorResponseSchema,
          [UNPROCESSABLE_ENTITY_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.deleteAccount.execute({
        // Never from the body: that would let any authenticated caller delete
        // anyone.
        userId: getPrincipal(request).id,
        password: request.body.password,
        device: buildDeviceContext(request),
      })

      // Sent unconditionally, like `logout-all`: if a cookie came with the
      // request, the row behind it just died, and leaving it in the browser
      // only produces a confusing 401 on the next refresh.
      clearRefreshCookie(reply)

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
  )
}

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
  NOT_FOUND_STATUS,
  OK_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
  UNPROCESSABLE_ENTITY_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  clearRefreshCookie,
  REFRESH_TRANSPORT_COOKIE,
  refreshTransportSchema,
  setRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'
import { sessionTokensSchema } from '#modules/auth/infra/http/session-tokens'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_PATTERN,
} from '#modules/auth/value-objects/password'

const CHANGE_PASSWORD_PATH = '/password'
const CHANGE_PASSWORD_SUMMARY = 'Change this account password'
const CHANGE_PASSWORD_DESCRIPTION =
  'Replaces the password of the authenticated user, who must present the ' +
  'current one. Every session on every device is revoked, and this device ' +
  'receives a fresh token pair in the response. Access tokens already issued ' +
  'stay valid until they expire.'

/**
 * A new example, distinct from `EXAMPLE_PASSWORD`: the two fields must differ
 * or "Try it out" in Swagger UI sends a request that answers 422.
 */
const EXAMPLE_NEW_PASSWORD = 'ev3nS4fer!'

const MIN_SUBMITTED_PASSWORD_LENGTH = 1

/**
 * `currentPassword` checks PRESENCE, not policy — the same call login makes.
 * Enforcing the rules on it would answer 400 where the right answer is 422,
 * telling an attacker the guess failed the RULES rather than the password, and
 * an account created under a looser policy must stay able to change it. The
 * ceiling stays for the unrelated reason: without one, a 10 MB body becomes
 * argon2 over 10 MB.
 *
 * `newPassword` carries the full policy, exactly as `register` does. Validating
 * here as well as in the `Password` value object is deliberate: this is what
 * gives the client a 400 with a per-field `details` array and what publishes
 * the policy in the OpenAPI document, while the value object keeps the use case
 * safe for the non-HTTP entrypoints.
 */
const bodySchema = z.object({
  currentPassword: z
    .string()
    .min(MIN_SUBMITTED_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .meta({ examples: [EXAMPLE_PASSWORD] }),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .regex(PASSWORD_POLICY_PATTERN)
    .meta({ examples: [EXAMPLE_NEW_PASSWORD] }),
  /**
   * The SECOND endpoint that needs this. Like `login`, it hands back a refresh
   * token without having received one, so nothing in the request reveals which
   * channel the client wants.
   */
  refreshTransport: refreshTransportSchema,
})

export const changePasswordRoute: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    CHANGE_PASSWORD_PATH,
    {
      preHandler: guard,
      /**
       * Tighter than the global ceiling, like login: this request carries a
       * password guess. The vector is a stolen access token being escalated
       * into a taken account.
       */
      config: { rateLimit: container.passwordChangeRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: CHANGE_PASSWORD_SUMMARY,
        description: CHANGE_PASSWORD_DESCRIPTION,
        security: [{ [BEARER_SECURITY_SCHEME]: [] }],
        body: bodySchema,
        response: {
          [OK_STATUS]: sessionTokensSchema,
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
      const { accessToken, refreshToken } = await container.changePassword.execute({
        // From the verified token, never the body: taking a userId from the
        // payload here would let any authenticated caller reset anyone.
        userId: getPrincipal(request).id,
        currentPassword: request.body.currentPassword,
        newPassword: request.body.newPassword,
        device: buildDeviceContext(request),
      })

      if (request.body.refreshTransport === REFRESH_TRANSPORT_COOKIE) {
        setRefreshCookie(reply, refreshToken, container.refreshTokenTtlSeconds)

        return reply.status(OK_STATUS).send({ accessToken })
      }

      // Body mode clears any cookie that was there: it now points at a family
      // that was just revoked, and leaving it in the browser only produces a
      // confusing 401 on the next refresh. Same reasoning as `logout-all`.
      clearRefreshCookie(reply)

      return reply.status(OK_STATUS).send({ accessToken, refreshToken })
    },
  )
}

import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  EXAMPLE_EMAIL,
  OK_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNPROCESSABLE_ENTITY_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  REFRESH_TRANSPORT_COOKIE,
  refreshTransportSchema,
  setRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'
import { sessionTokensSchema } from '#modules/auth/infra/http/session-tokens'
import { MAX_EMAIL_LENGTH } from '#modules/auth/value-objects/email'

const CONFIRM_EMAIL_PATH = '/email/verify'
const CONFIRM_EMAIL_SUMMARY = 'Confirm an email address'
const CONFIRM_EMAIL_DESCRIPTION =
  'Redeems the six-digit code emailed at registration, marks the account ' +
  'verified, and opens a session — the same pair `login` issues.'

const VERIFICATION_CODE_PATTERN = /^[0-9]{6}$/
const EXAMPLE_VERIFICATION_CODE = '042317'
const VERIFICATION_CODE_REASON = 'must be exactly six digits'

/**
 * `email`, in the same shape `register` validates it: presence and format at
 * the wire boundary, so a malformed address answers 400 with a per-field
 * `details` array before it ever reaches `Email.create`.
 *
 * `code` checks the SHAPE only — six digits — never a value the client could
 * infer anything from. Whether that shape is the right code, or belongs to a
 * usable verification at all, is `EmailVerificationFailedError` territory
 * (§6.3 of the design spec): one answer for every failure mode.
 */
const bodySchema = z.object({
  email: z
    .string()
    .trim()
    .max(MAX_EMAIL_LENGTH)
    .pipe(z.email())
    .meta({ examples: [EXAMPLE_EMAIL] }),
  code: z
    .string()
    .regex(VERIFICATION_CODE_PATTERN, VERIFICATION_CODE_REASON)
    .meta({ examples: [EXAMPLE_VERIFICATION_CODE] }),
  /**
   * Which channel carries the refresh token back. This route mints a BRAND
   * NEW session with no incoming cookie or bearer either — the third endpoint
   * `refresh-cookie.ts` documents, alongside `login` and `change-password`,
   * with no signal of its own to tell a mobile client from a web one.
   */
  refreshTransport: refreshTransportSchema,
})

export const confirmEmailRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    CONFIRM_EMAIL_PATH,
    {
      /**
       * Tighter than the global ceiling, like `login`: a request here carries a
       * code guess against a six-digit space, and its own numbers rather than
       * borrowing `loginRateLimit` or `registerRateLimit` — a field named for
       * one route and used by another is a comment that lies.
       */
      config: { rateLimit: container.emailVerifyRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: CONFIRM_EMAIL_SUMMARY,
        description: CONFIRM_EMAIL_DESCRIPTION,
        body: bodySchema,
        response: {
          [OK_STATUS]: sessionTokensSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNPROCESSABLE_ENTITY_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
          // This route opens a transaction to consume the code: a deadlock
          // that survives the runner's retries surfaces as
          // `TransactionConflictError`, exactly like `register`.
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accessToken, refreshToken } = await container.confirmEmail.execute(
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

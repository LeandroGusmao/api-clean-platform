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

const RESEND_VERIFICATION_PATH = '/email/verify/resend'
const RESEND_VERIFICATION_SUMMARY = 'Resend the email verification code'
const RESEND_VERIFICATION_DESCRIPTION =
  'Requests a fresh six-digit verification code for a pending registration. ' +
  'Always answers 202 with an empty body — for an address with no pending ' +
  'registration, one that already has a real account, a request made inside ' +
  'the resend cooldown, and a code actually sent, the status and body are ' +
  'identical. The LATENCY is not: the branch that actually sends pays an ' +
  'UPDATE and an SMTP round trip the other three do not, and closing that gap ' +
  'needs the mail send off the request path entirely — accepted for now, and ' +
  'recorded in the design spec.'

const bodySchema = z.object({
  email: z
    .string()
    .trim()
    .max(MAX_EMAIL_LENGTH)
    .pipe(z.email())
    .meta({ examples: [EXAMPLE_EMAIL] }),
})

export const resendVerificationRoute: FastifyPluginAsync<{
  container: AuthContainer
}> = async (app, { container }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    RESEND_VERIFICATION_PATH,
    {
      /**
       * Its own ceiling, tighter than `emailVerifyRateLimit`: an anonymous
       * request here spams a stranger's inbox by re-minting a pending
       * registration's code.
       */
      config: { rateLimit: container.emailVerifyResendRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: RESEND_VERIFICATION_SUMMARY,
        description: RESEND_VERIFICATION_DESCRIPTION,
        body: bodySchema,
        response: {
          // `z.null()` and not an omitted entry: with the Zod type provider a
          // handler may only answer a status the schema declares. See the
          // same note on `register`.
          //
          // 503 is GONE: this route no longer opens a transaction — it does one
          // autocommit UPDATE — so no `TransactionConflictError` can reach the
          // wire (§7.1 of the slice 11 design).
          [ACCEPTED_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.requestEmailVerification.execute(request.body)

      return reply.status(ACCEPTED_STATUS).send(null)
    },
  )
}

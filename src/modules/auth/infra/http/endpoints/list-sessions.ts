import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { getPrincipal } from '#infra/http/auth-guard'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import { BEARER_SECURITY_SCHEME } from '#infra/http/openapi'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  EXAMPLE_SESSION_ID,
  OK_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'

const SESSIONS_PATH = '/sessions'
const SESSIONS_SUMMARY = 'List the active sessions of the authenticated user'
const SESSIONS_DESCRIPTION =
  'One entry per refresh-token family that still has a live, unrevoked, ' +
  'unexpired row — a family is opened by login and stays the same chain ' +
  'through every rotation, so it IS the session. No device information: ' +
  'without it, entries cannot be told apart beyond their timestamps.'

const sessionSchema = z.object({
  id: z.uuid().meta({ examples: [EXAMPLE_SESSION_ID] }),
  createdAt: z.date(),
  expiresAt: z.date(),
})

export const listSessionsRoute: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    SESSIONS_PATH,
    {
      preHandler: guard,
      schema: {
        tags: [AUTH_TAG],
        summary: SESSIONS_SUMMARY,
        description: SESSIONS_DESCRIPTION,
        security: [{ [BEARER_SECURITY_SCHEME]: [] }],
        response: {
          [OK_STATUS]: z.array(sessionSchema),
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const sessions = await container.listActiveSessions.execute(
        getPrincipal(request).id,
      )

      return reply.status(OK_STATUS).send(sessions)
    },
  )
}

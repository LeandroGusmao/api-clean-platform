import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { Database } from '#infra/database/client'
import { checkDatabase } from '#infra/health/checks/database-check'

const HEALTH_CHECK_PATH = '/health'
const HEALTH_TAG = 'Health'
const HEALTH_SUMMARY = 'Liveness and dependency check'
const HEALTH_DESCRIPTION =
  'Reports whether the service is up and its dependencies are reachable. ' +
  'Returns 503 when any dependency is down, so an orchestrator can pull the ' +
  'instance out of rotation.'
const OK_STATUS = 'ok' as const
const ERROR_STATUS = 'error' as const
const DATABASE_UP = 'up' as const
const DATABASE_DOWN = 'down' as const
const SERVICE_UNAVAILABLE_STATUS = 503

const okSchema = z.object({
  status: z.literal(OK_STATUS),
  database: z.literal(DATABASE_UP),
})
const downSchema = z.object({
  status: z.literal(ERROR_STATUS),
  database: z.literal(DATABASE_DOWN),
})

export const healthRoute: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    HEALTH_CHECK_PATH,
    {
      schema: {
        tags: [HEALTH_TAG],
        summary: HEALTH_SUMMARY,
        description: HEALTH_DESCRIPTION,
        response: { 200: okSchema, [SERVICE_UNAVAILABLE_STATUS]: downSchema },
      },
    },
    async (request, reply) => {
      const database = await checkDatabase(db)

      if (!database.up) {
        request.log.error(database.error, 'database health check failed')
        return reply
          .status(SERVICE_UNAVAILABLE_STATUS)
          .send({ status: ERROR_STATUS, database: DATABASE_DOWN })
      }

      return { status: OK_STATUS, database: DATABASE_UP }
    },
  )
}

import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { DatabaseCheck } from '#infra/health/checks/database-check'
import { checkRedis, type HealthRedis } from '#infra/health/checks/redis-check'

const HEALTH_CHECK_PATH = '/health'
const HEALTH_TAG = 'Health'
const HEALTH_SUMMARY = 'Liveness and dependency check'
const HEALTH_DESCRIPTION =
  'Reports whether the service is up and its dependencies are reachable. ' +
  'Returns 503 when the database is down, so an orchestrator can pull the ' +
  'instance out of rotation. Redis is reported but never fails the probe.'
const OK_STATUS = 'ok' as const
const ERROR_STATUS = 'error' as const
const DATABASE_UP = 'up' as const
const DATABASE_DOWN = 'down' as const
const REDIS_UP = 'up' as const
const REDIS_DOWN = 'down' as const
const OK_HTTP_STATUS = 200
const SERVICE_UNAVAILABLE_STATUS = 503

const redisSchema = z.enum([REDIS_UP, REDIS_DOWN])
const okSchema = z.object({
  status: z.literal(OK_STATUS),
  database: z.literal(DATABASE_UP),
  redis: redisSchema,
})
const downSchema = z.object({
  status: z.literal(ERROR_STATUS),
  database: z.literal(DATABASE_DOWN),
  redis: redisSchema,
})

export const healthRoute: FastifyPluginAsync<{
  checkDatabase: DatabaseCheck
  redis: HealthRedis
}> = async (app, { checkDatabase, redis }) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    HEALTH_CHECK_PATH,
    {
      /**
       * Never rate limited, and this is correctness rather than convenience: a
       * liveness probe that takes a 429 makes the orchestrator kill the pod, so
       * the limiter would take down the application it exists to protect.
       *
       * Declared on the route rather than in the limiter's `allowList` for two
       * measured reasons: `allowList` compares against the generated KEY and
       * never against the path, so a list of paths exempts nothing while
       * looking correct; and an exemption matching a path by string would break
       * in silence the day this route is renamed.
       */
      config: { rateLimit: false },
      schema: {
        tags: [HEALTH_TAG],
        summary: HEALTH_SUMMARY,
        description: HEALTH_DESCRIPTION,
        response: {
          [OK_HTTP_STATUS]: okSchema,
          [SERVICE_UNAVAILABLE_STATUS]: downSchema,
        },
      },
    },
    async (request, reply) => {
      const [database, redisCheck] = await Promise.all([
        checkDatabase(),
        checkRedis(redis),
      ])
      // Not logged here: an outage is already reported once, when the client
      // loses the connection, and a probe polling every few seconds would repeat
      // it for as long as it lasts.
      const redisStatus = redisCheck.up ? REDIS_UP : REDIS_DOWN

      if (!database.up) {
        request.log.error(database.error, 'database health check failed')
        return reply
          .status(SERVICE_UNAVAILABLE_STATUS)
          .send({ status: ERROR_STATUS, database: DATABASE_DOWN, redis: redisStatus })
      }

      return { status: OK_STATUS, database: DATABASE_UP, redis: redisStatus }
    },
  )
}

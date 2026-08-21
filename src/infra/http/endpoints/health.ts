import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

const HEALTH_CHECK_PATH = '/health'
const OK_STATUS = 'ok' as const

const okSchema = z.object({ status: z.literal(OK_STATUS) })

export const healthRoute: FastifyPluginAsync = async (app) => {
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(HEALTH_CHECK_PATH, { schema: { response: { 200: okSchema } } }, async () => ({
      status: OK_STATUS,
    }))
}

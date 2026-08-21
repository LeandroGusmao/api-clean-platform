import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import type { FastifyInstance } from 'fastify'
import { jsonSchemaTransform } from 'fastify-type-provider-zod'
import { type Env, NODE_ENV_DEVELOPMENT } from '#infra/config/env'

const OPENAPI_VERSION = '3.1.0'
const API_TITLE = 'API Clean Platform'
const API_DESCRIPTION = 'HTTP API built on the Clean Platform boilerplate.'
const API_VERSION = '0.0.0'

export const DOCS_ROUTE_PREFIX = '/docs'

/**
 * Registers OpenAPI generation and the docs UI.
 *
 * Only runs in development: no deployed environment should publish the API
 * surface. Call this BEFORE registering any route — `@fastify/swagger` hooks
 * `onRoute`, so routes registered earlier are absent from the document.
 */
export async function registerOpenApi(app: FastifyInstance, env: Env): Promise<void> {
  if (env.NODE_ENV !== NODE_ENV_DEVELOPMENT) return

  await app.register(fastifySwagger, {
    openapi: {
      openapi: OPENAPI_VERSION,
      info: {
        title: API_TITLE,
        description: API_DESCRIPTION,
        version: API_VERSION,
      },
    },
    // Converts the endpoints' raw Zod schemas into JSON Schema. Without it
    // the generated document is empty.
    transform: jsonSchemaTransform,
  })

  await app.register(fastifySwaggerUi, { routePrefix: DOCS_ROUTE_PREFIX })
}

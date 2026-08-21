import { env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import { healthRoute } from '#infra/http/endpoints/health'
import { registerOpenApi } from '#infra/http/openapi'
import { buildServer } from '#infra/http/server'

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const app = buildServer(env)
const { db, pool } = createDatabase(env)

// Must come before any route: `@fastify/swagger` only documents what is
// registered after it.
await registerOpenApi(app, env)

await app.register(healthRoute, { db })

for (const signal of SHUTDOWN_SIGNALS) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app.close().then(
      () =>
        pool.end().then(
          () => process.exit(0),
          () => process.exit(1),
        ),
      () => process.exit(1),
    )
  })
}

try {
  await app.listen({ host: env.HOST, port: env.PORT })
} catch (err) {
  app.log.fatal(err, 'failed to start the server')
  process.exit(1)
}

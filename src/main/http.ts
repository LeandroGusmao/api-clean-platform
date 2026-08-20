import { env } from '#infra/config/env'
import { buildServer } from '#infra/http/server'

const app = buildServer(env)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app.close().then(
      () => process.exit(0),
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

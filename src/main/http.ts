import { env } from '#infra/config/env'
import { buildApp } from './app.js'

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const app = await buildApp(env)

for (const signal of SHUTDOWN_SIGNALS) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    // Closing the app also ends the database pool — see the `onClose` hook in
    // `app.ts`.
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

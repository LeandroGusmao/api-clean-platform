import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import type { AuthContainer } from '#modules/auth/container'
import { changePasswordRoute } from './endpoints/change-password.js'
import { confirmEmailRoute } from './endpoints/confirm-email.js'
import { forgotPasswordRoute } from './endpoints/forgot-password.js'
import { loginRoute } from './endpoints/login.js'
import { logoutRoute } from './endpoints/logout.js'
import { logoutAllRoute } from './endpoints/logout-all.js'
import { meRoute } from './endpoints/me.js'
import { refreshRoute } from './endpoints/refresh.js'
import { registerRoute } from './endpoints/register.js'
import { resendVerificationRoute } from './endpoints/resend-verification.js'
import { resetPasswordRoute } from './endpoints/reset-password.js'

/**
 * The module's HTTP surface. Thin by design: a new endpoint is a new file plus
 * one line here.
 *
 * It receives only the module's own slice of the container (decision 23), plus
 * the guard the composition root built — the guard is generic global infra, so
 * the module never imports a protection mechanism of its own.
 */
export const authRoutes: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  await app.register(registerRoute, { container })
  await app.register(confirmEmailRoute, { container })
  await app.register(resendVerificationRoute, { container })
  await app.register(loginRoute, { container })
  await app.register(refreshRoute, { container })
  await app.register(forgotPasswordRoute, { container })
  await app.register(resetPasswordRoute, { container })
  await app.register(logoutRoute, { container })
  await app.register(logoutAllRoute, { container, guard })
  await app.register(changePasswordRoute, { container, guard })
  await app.register(meRoute, { container, guard })
}

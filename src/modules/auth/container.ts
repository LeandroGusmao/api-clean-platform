import type { Env } from '#infra/config/env'
import type { Database } from '#infra/database/client'
import type { TransactionRunner } from '#infra/database/transaction-runner'
import { createUnitOfWork } from '#infra/database/unit-of-work'
import {
  BestEffortEmailSender,
  type ErrorLogger,
} from '#infra/providers/best-effort-email-sender'
import { RandomTokenGenerator } from '#infra/providers/random-token-generator'
import { Sha256TokenDigest } from '#infra/providers/sha256-token-digest'
import { SmtpEmailSender } from '#infra/providers/smtp-email-sender'
import { SystemClock } from '#infra/providers/system-clock'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'
import type { AuthConfig } from './config.js'

/** Windows are configured in seconds; the entity and the rate limiter take milliseconds. */
const MILLISECONDS_PER_SECOND = 1000

/**
 * What this module is allowed to see of the environment: its OWN variables,
 * plus the `MAIL_*` keys the SMTP adapter needs.
 *
 * `Pick<Env, ...>` and never `Env`: with the whole type this module could read
 * `DATABASE_URL`, and decision 23 would rest on nobody doing it rather than on
 * the compiler. `makeContainer` still passes `env` whole and structural typing
 * narrows it here, so no call site changes.
 */
export type AuthContainerConfig = AuthConfig &
  Pick<
    Env,
    | 'MAIL_HOST'
    | 'MAIL_PORT'
    | 'MAIL_SECURE'
    | 'MAIL_REQUIRE_TLS'
    | 'MAIL_FROM'
    | 'MAIL_USER'
    | 'MAIL_PASSWORD'
  >

import { authRepositories } from './infra/drizzle/auth-repositories.js'
import { Argon2HashProvider } from './infra/providers/argon2-hash-provider.js'
import { JwtTokenSigner } from './infra/providers/jwt-token-signer.js'
import { EmailVerificationIssuer } from './services/email-verification-issuer.js'
import { RefreshTokenIssuer } from './services/refresh-token-issuer.js'
import { ChangePasswordUseCase } from './use-cases/change-password.js'
import { ConfirmEmailUseCase } from './use-cases/confirm-email.js'
import { GetUserProfileUseCase } from './use-cases/get-user-profile.js'
import { LoginUserUseCase } from './use-cases/login-user.js'
import { LogoutUseCase } from './use-cases/logout.js'
import { LogoutAllUseCase } from './use-cases/logout-all.js'
import { RefreshTokenUseCase } from './use-cases/refresh-token.js'
import { RegisterUserUseCase } from './use-cases/register-user.js'
import { RequestEmailVerificationUseCase } from './use-cases/request-email-verification.js'

/**
 * The module's slice of the dependency graph. This file is `composition`: it is
 * the one place inside the module allowed to know concrete implementations —
 * that is the whole point of a composition root (decision 08).
 *
 * Stateless objects (repository, providers) are singletons here. Instantiating
 * a class costs nanoseconds against milliseconds of network and database, so
 * the cost is noise; the reason to avoid `new` in a handler was never
 * performance, it was coupling.
 */
export function makeAuthContainer(
  db: Database,
  config: AuthContainerConfig,
  runner: TransactionRunner,
  logger: ErrorLogger,
) {
  const {
    users: usersRepository,
    refreshTokens: refreshTokensRepository,
    pendingRegistrations: pendingRegistrationsRepository,
  } = authRepositories(db)
  const hashProvider = new Argon2HashProvider()
  const clock = new SystemClock()
  const idGenerator = new UuidIdGenerator()
  const tokenSigner = new JwtTokenSigner(config, clock)
  const tokenGenerator = new RandomTokenGenerator()
  const tokenDigest = new Sha256TokenDigest()
  const uow = createUnitOfWork(runner, authRepositories)
  const refreshTokenIssuer = new RefreshTokenIssuer(
    tokenGenerator,
    tokenDigest,
    idGenerator,
    config.REFRESH_TOKEN_TTL_SECONDS,
  )
  /**
   * One transport for the process — `smtpTransportOptions` sets `pool: true`,
   * so connections are reused across sends. `closeEmailTransport` tears it down.
   */
  const emailSender = new SmtpEmailSender({
    host: config.MAIL_HOST,
    port: config.MAIL_PORT,
    secure: config.MAIL_SECURE,
    requireTls: config.MAIL_REQUIRE_TLS,
    from: config.MAIL_FROM,
    user: config.MAIL_USER,
    password: config.MAIL_PASSWORD,
  })
  const emailVerificationIssuer = new EmailVerificationIssuer(
    emailSender,
    tokenGenerator,
    tokenDigest,
    idGenerator,
    config.EMAIL_VERIFICATION_TTL_SECONDS,
  )
  /**
   * Wrapped for exactly one notification. Everything else gets the bare sender,
   * so a verification code that cannot be delivered still fails loudly.
   */
  const passwordChangedEmailSender = new BestEffortEmailSender(emailSender, logger)

  return {
    registerUser: new RegisterUserUseCase(
      usersRepository,
      pendingRegistrationsRepository,
      emailVerificationIssuer,
      emailSender,
      clock,
      idGenerator,
      config.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND,
      config.EMAIL_VERIFICATION_MAX_ATTEMPTS,
      config.EMAIL_VERIFICATION_TTL_SECONDS,
    ),
    loginUser: new LoginUserUseCase(
      usersRepository,
      hashProvider,
      tokenSigner,
      refreshTokensRepository,
      refreshTokenIssuer,
      clock,
    ),
    getUserProfile: new GetUserProfileUseCase(usersRepository),
    refreshToken: new RefreshTokenUseCase(
      uow,
      refreshTokenIssuer,
      tokenSigner,
      tokenDigest,
      clock,
      config.REFRESH_TOKEN_GRACE_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    ),
    logout: new LogoutUseCase(uow, tokenDigest, clock),
    logoutAll: new LogoutAllUseCase(uow, clock),
    changePassword: new ChangePasswordUseCase(
      usersRepository,
      uow,
      hashProvider,
      tokenSigner,
      refreshTokenIssuer,
      clock,
      passwordChangedEmailSender,
    ),
    confirmEmail: new ConfirmEmailUseCase(
      pendingRegistrationsRepository,
      uow,
      refreshTokenIssuer,
      tokenSigner,
      tokenDigest,
      hashProvider,
      clock,
      idGenerator,
      config.EMAIL_VERIFICATION_MAX_ATTEMPTS,
    ),
    requestEmailVerification: new RequestEmailVerificationUseCase(
      usersRepository,
      pendingRegistrationsRepository,
      emailVerificationIssuer,
      clock,
      config.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND,
      config.EMAIL_VERIFICATION_MAX_ATTEMPTS,
      config.EMAIL_VERIFICATION_TTL_SECONDS,
    ),
    /**
     * Not a use case: there is nothing to orchestrate. Decision 11 keeps the
     * database out of the authenticated path, so verification is signature
     * checking and nothing else. Published here so the composition root can
     * build the generic guard without any module coupling.
     */
    verifyAccessToken: (token: string) => tokenSigner.verify(token),
    /**
     * The cookie's `Max-Age` has to match the token's own lifetime, and the
     * endpoint is where the cookie is written — so both read this one value and
     * cannot drift apart.
     */
    refreshTokenTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
    /**
     * The login route declares its own ceiling, so the endpoint needs the
     * numbers. Milliseconds here because that is what the limiter's
     * `timeWindow` takes, and converting once keeps arithmetic out of the
     * endpoint.
     */
    /**
     * Its own ceiling because it sends mail: an anonymous request putting a
     * message in an arbitrary inbox is a spam amplifier. Its own numbers, not
     * login's, for the reason login already documents.
     */
    registerRateLimit: {
      max: config.REGISTER_RATE_LIMIT_MAX_REQUESTS,
      timeWindow: config.REGISTER_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
    loginRateLimit: {
      max: config.LOGIN_RATE_LIMIT_MAX_REQUESTS,
      timeWindow: config.LOGIN_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
    /**
     * The confirm route declares its own ceiling, like login: a request here
     * carries a code guess against a six-digit space. Its own numbers, not
     * login's or register's, for the reason login already documents.
     */
    emailVerifyRateLimit: {
      max: config.EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS,
      timeWindow: config.EMAIL_VERIFY_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
    /**
     * The resend route declares its own ceiling, tighter than `emailVerifyRateLimit`:
     * an anonymous request here both spams a stranger's inbox and can burn
     * their live code by racing a fresh one into existence, so its budget is
     * its own numbers rather than borrowed ones.
     */
    emailVerifyResendRateLimit: {
      max: config.EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS,
      timeWindow:
        config.EMAIL_VERIFY_RESEND_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
    /**
     * The password change route declares its own ceiling, like login.
     * Milliseconds because that is what the limiter's `timeWindow` takes.
     */
    passwordChangeRateLimit: {
      max: config.PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS,
      timeWindow:
        config.PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
    /**
     * Still published, and now it has consumers: the rotation, both logouts and
     * the password change open their transaction through it.
     * `tests/integration/unit-of-work.spec.ts` also reaches for it directly, to
     * exercise the primitive on its own.
     */
    uow,
    /**
     * Drains the SMTP transport's pooled connections. `buildApp` wires this
     * into Fastify's `onClose`, next to the database pool's own `pool.end()` —
     * `app.close()` is meant to be the ONE shutdown path, so nothing outside
     * this module has to know the transport is pooled at all, only that it
     * needs closing.
     */
    closeEmailTransport: () => emailSender.close(),
  }
}

export type AuthContainer = ReturnType<typeof makeAuthContainer>

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
 * WIDENED rather than joined by a second parameter. `makeContainer` already
 * passes `env` whole and structural typing narrows it at the boundary
 * (decision 23) — so listing the mail keys here keeps that mechanism intact and
 * changes no call site. `Pick<Env, ...>` and never `Env`: with the whole type,
 * this module could read `DATABASE_URL`, and the rule would rest on nobody
 * doing it rather than on the compiler.
 *
 * The mail keys are core and not the module's own because sending mail is a
 * cross-cutting capability, not a concept of authentication — the same reason
 * `IEmailSender` lives in `shared/` and not in `modules/auth/ports/`.
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
    emailVerifications: emailVerificationsRepository,
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
   * One transport for the process: nodemailer pools connections across sends,
   * so rebuilding it per request would open a fresh TCP and TLS handshake for
   * every verification code.
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
   * Wraps the bare sender for exactly one notification. A verification code
   * must propagate its failure (the account is unusable without it, and a
   * retry heals through the collision path); "your password was changed" must
   * not, because the password has already changed and a 500 here would tell
   * the owner the change failed while their old password no longer works.
   */
  const passwordChangedEmailSender = new BestEffortEmailSender(emailSender, logger)

  return {
    /**
     * Takes two autocommit repositories AND the unit of work, for the reason
     * §9 permits: both are READS on the collision path, made after the failed
     * transaction has already rolled back. The constructor's `Pick`s are what
     * make a write through either of them a compile error.
     */
    registerUser: new RegisterUserUseCase(
      usersRepository,
      emailVerificationsRepository,
      uow,
      emailVerificationIssuer,
      emailSender,
      hashProvider,
      clock,
      idGenerator,
      config.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND,
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
    /**
     * Takes the users repository AND the unit of work. §9 of the unit of work
     * design permits that for a READ: the argon2 compare needs the stored hash,
     * and argon2 may not run inside the transaction. Every write goes through
     * the callback's `repos`.
     */
    changePassword: new ChangePasswordUseCase(
      usersRepository,
      uow,
      hashProvider,
      tokenSigner,
      refreshTokenIssuer,
      clock,
      passwordChangedEmailSender,
    ),
    /**
     * Takes the users repository AND `emailVerifications.incrementAttempts`
     * directly, alongside the unit of work. §9 permits the first for the same
     * reason `changePassword` gets one; the second is the exception its own
     * constructor comment documents — a write outside the transaction, because
     * §8's third line says a brute-force counter written inside one that rolls
     * back is erased exactly when it matters.
     */
    confirmEmail: new ConfirmEmailUseCase(
      usersRepository,
      emailVerificationsRepository,
      uow,
      refreshTokenIssuer,
      tokenSigner,
      tokenDigest,
      clock,
      config.EMAIL_VERIFICATION_MAX_ATTEMPTS,
    ),
    /**
     * Takes the users repository AND the email verifications repository
     * DIRECTLY, alongside the unit of work — both narrowed to `Pick`, per §9:
     * one is the lookup, the other the cooldown check, and neither is ever a
     * write outside the transaction the issuer opens.
     */
    requestEmailVerification: new RequestEmailVerificationUseCase(
      usersRepository,
      emailVerificationsRepository,
      uow,
      emailVerificationIssuer,
      clock,
      config.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND,
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
     * The registration route declares its own ceiling now that it sends mail:
     * an anonymous request putting a message in an arbitrary inbox is a spam
     * amplifier, and it inherited only the global 300/min before this slice.
     * Its own numbers, not login's, for the reason login already documents.
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
  }
}

export type AuthContainer = ReturnType<typeof makeAuthContainer>

import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { EmailVerification } from '#modules/auth/entities/email-verification'
import { User } from '#modules/auth/entities/user'
import { EmailVerificationFailedError } from '#modules/auth/errors/email-verification-failed-error'
import { InMemoryEmailVerificationsRepository } from '#modules/auth/infra/in-memory/in-memory-email-verifications-repository'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import {
  type ConfirmEmailCommand,
  ConfirmEmailUseCase,
} from '#modules/auth/use-cases/confirm-email'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { ITokenDigest } from '#shared/ports/token-digest'

const USER_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const VERIFICATION_ID = '2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091'
const EMAIL = 'joao@example.com'
/** An address with no account. The stored user keeps `EMAIL`. */
const UNKNOWN_EMAIL = 'ninguem@example.com'

/** Six digits, like the real generator's. */
const CODE = '123456'
const WRONG_CODE = '654321'

const NOW = new Date('2026-09-03T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const PASSWORD_HASH = 'hashed:whatever-they-chose'

const MILLISECONDS_PER_SECOND = 1000
const VERIFICATION_TTL_SECONDS = 900
const MAX_ATTEMPTS = 5
const NO_ATTEMPTS_SPENT = 0
/** Minted this instant: comfortably inside the window. */
const FRESH_AGE_MS = 0
/**
 * EXACTLY the TTL, which pins the expiry boundary as inclusive: `isUsable`
 * asks `expiresAt > now`, so a code whose expiry has just ARRIVED is spent. A
 * comfortably older code would leave `>` and `>=` indistinguishable.
 */
const EXPIRED_AGE_MS = VERIFICATION_TTL_SECONDS * MILLISECONDS_PER_SECOND
/** Enough to make two readings distinguishable; nothing depends on the size. */
const CLOCK_STEP_MS = 1

const DIGEST_PREFIX = 'digest:'
const ACCESS_TOKEN = 'signed-access-token'
const OPAQUE_TOKEN = 'opaque-refresh-token'
/** Unused by this suite; required only to satisfy `ITokenGenerator`. */
const NUMERIC_CODE = '000000'
const GENERATED_ID = 'generated-id'
const REFRESH_TOKEN_TTL_SECONDS = 3600

const ONE_CALL = 1

/**
 * The wire contract of the single error, spelled out rather than imported:
 * importing the constants from `email-verification-failed-error.ts` would make
 * the assertion tautological — it would pass whatever that file happened to
 * say, including a message that named which of the six branches failed.
 */
const FAILURE_MESSAGE = 'Email verification failed'
const FAILURE_CODE = 'EMAIL_VERIFICATION_FAILED'

const NO_FAILURE_MESSAGE = 'expected the confirmation to fail, and it resolved'
const USER_MISSING_MESSAGE = 'the repository stored no user'

/** Records the order in which collaborators were touched. */
const CONSUME_CALL = 'verifications.consume'
const MARK_VERIFIED_CALL = 'users.markEmailVerified'
const SAVE_TOKEN_CALL = 'refreshTokens.save'
const INCREMENT_ATTEMPTS_CALL = 'verifications.incrementAttempts'
const COMMIT = 'COMMIT'

/**
 * Whether the conditional `UPDATE` still finds the row unconsumed. `LOST_RACE`
 * is the one failure mode the in-memory repository cannot produce on its own —
 * a unit test runs one call at a time, so nothing can burn the code between
 * this request's read and its transaction.
 */
const WON_RACE = true
const LOST_RACE = false

const digest: ITokenDigest = { hash: (value) => `${DIGEST_PREFIX}${value}` }

let callLog: string[]
let consumeOutcome: boolean
let usersRepository: InMemoryUsersRepository
let verificationsRepository: InMemoryEmailVerificationsRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
let useCase: ConfirmEmailUseCase
// Typed with the real signatures rather than a bare `ReturnType<typeof vi.fn>`,
// which erases them: the erased form compiles at the declaration and then fails
// where the spy is handed to a port, several lines away.
let incrementAttemptsSpy: Mock<IEmailVerificationsRepository['incrementAttempts']>
let signSpy: Mock<ITokenSigner['sign']>
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>

/**
 * The repositories as the transaction hands them out, wrapping the SAME
 * in-memory instances — one database, two handles. Only the three writes the
 * flow makes inside the transaction are logged; everything else is passthrough.
 */
function trackedRepos(): AuthRepos {
  return {
    users: {
      save: (user) => usersRepository.save(user),
      findByEmail: (email) => usersRepository.findByEmail(email),
      findById: (id) => usersRepository.findById(id),
      updatePasswordHash: (id, passwordHash, updatedAt) =>
        usersRepository.updatePasswordHash(id, passwordHash, updatedAt),
      markEmailVerified: (id, verifiedAt, updatedAt) => {
        callLog.push(MARK_VERIFIED_CALL)
        return usersRepository.markEmailVerified(id, verifiedAt, updatedAt)
      },
    },
    refreshTokens: {
      save: (token) => {
        callLog.push(SAVE_TOKEN_CALL)
        return refreshTokensRepository.save(token)
      },
      findByHashForUpdate: (hash) => refreshTokensRepository.findByHashForUpdate(hash),
      markRotated: (id, replacedBy, revokedAt) =>
        refreshTokensRepository.markRotated(id, replacedBy, revokedAt),
      revoke: (id, revokedAt) => refreshTokensRepository.revoke(id, revokedAt),
      revokeFamily: (familyId, revokedAt) =>
        refreshTokensRepository.revokeFamily(familyId, revokedAt),
      revokeAllForUser: (userId, revokedAt) =>
        refreshTokensRepository.revokeAllForUser(userId, revokedAt),
    },
    emailVerifications: {
      save: (verification) => verificationsRepository.save(verification),
      findActiveByUserId: (userId) => verificationsRepository.findActiveByUserId(userId),
      invalidateActiveForUser: (userId, at) =>
        verificationsRepository.invalidateActiveForUser(userId, at),
      incrementAttempts: (id) => verificationsRepository.incrementAttempts(id),
      consume: async (id, at) => {
        callLog.push(CONSUME_CALL)
        if (consumeOutcome === LOST_RACE) return LOST_RACE

        return verificationsRepository.consume(id, at)
      },
    },
  }
}

function buildUseCase(clock: IClock): ConfirmEmailUseCase {
  return new ConfirmEmailUseCase(
    usersRepository,
    {
      findActiveByUserId: (userId) => verificationsRepository.findActiveByUserId(userId),
      incrementAttempts: incrementAttemptsSpy,
    },
    // Cast because `IAuthUnitOfWork` is generic in the callback's return type
    // and `vi.fn` cannot produce a generic function. The spy's own signature is
    // still checked where it is declared; only the generic instantiation is
    // waived here.
    uowSpy as unknown as IAuthUnitOfWork,
    new RefreshTokenIssuer(
      { opaque: () => OPAQUE_TOKEN, numericCode: () => NUMERIC_CODE },
      digest,
      { generate: () => GENERATED_ID },
      REFRESH_TOKEN_TTL_SECONDS,
    ),
    { sign: signSpy, verify: async () => ({ sub: USER_ID }) },
    digest,
    clock,
    MAX_ATTEMPTS,
  )
}

beforeEach(() => {
  callLog = []
  consumeOutcome = WON_RACE
  usersRepository = new InMemoryUsersRepository()
  verificationsRepository = new InMemoryEmailVerificationsRepository()
  refreshTokensRepository = new InMemoryRefreshTokensRepository()

  incrementAttemptsSpy = vi.fn(async (id) => {
    callLog.push(INCREMENT_ATTEMPTS_CALL)
    await verificationsRepository.incrementAttempts(id)
  })

  // Records the payload. A fake that ignored it would let the use case sign for
  // any subject at all with every assertion in this file still green — and on
  // an endpoint that MINTS a session, "which subject did we sign for" is
  // exactly what turns a wiring slip into an authorization bug.
  signSpy = vi.fn(async () => ACCESS_TOKEN)

  const repos = trackedRepos()

  /**
   * The `uow` fake appends `COMMIT` when — and only when — the callback
   * resolves. That marker is what turns the order assertions below into
   * statements about §8: a write recorded before it is a write inside the
   * transaction, and one recorded after a rejection would not be recorded at
   * all.
   */
  uowSpy = vi.fn(async (work) => {
    const result = await work(repos)
    callLog.push(COMMIT)

    return result
  })

  useCase = buildUseCase({ now: () => NOW })
})

function storeUser(): void {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: PASSWORD_HASH,
      emailVerifiedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

/**
 * `fromTrusted` and not `create`, because two of the six failure modes are
 * states `create` cannot produce: a spent attempt budget, and an expiry already
 * behind us.
 */
function storeVerification(
  { ageMs, attempts }: { ageMs: number; attempts: number } = {
    ageMs: FRESH_AGE_MS,
    attempts: NO_ATTEMPTS_SPENT,
  },
): void {
  const createdAt = new Date(NOW.getTime() - ageMs)

  verificationsRepository.verifications.push(
    EmailVerification.fromTrusted({
      id: VERIFICATION_ID,
      userId: USER_ID,
      codeHash: `${DIGEST_PREFIX}${CODE}`,
      expiresAt: new Date(
        createdAt.getTime() + VERIFICATION_TTL_SECONDS * MILLISECONDS_PER_SECOND,
      ),
      consumedAt: null,
      attempts,
      createdAt,
    }),
  )
}

function storeVerifiableAccount(): void {
  storeUser()
  storeVerification()
}

const confirm = (overrides: Partial<ConfirmEmailCommand> = {}) =>
  useCase.execute({ email: EMAIL, code: CODE, ...overrides })

const storedUser = () => {
  const [user] = usersRepository.users
  if (user === undefined) throw new Error(USER_MISSING_MESSAGE)

  return user
}

const storedVerification = () => verificationsRepository.verifications[0]

const issuedToken = () =>
  refreshTokensRepository.tokens.find(
    (token) => token.tokenHash === `${DIGEST_PREFIX}${OPAQUE_TOKEN}`,
  )

async function failureFrom(promise: Promise<unknown>): Promise<{
  message: string
  code: string
}> {
  try {
    await promise
  } catch (error) {
    if (error instanceof EmailVerificationFailedError) {
      return { message: error.message, code: error.code }
    }

    throw error
  }

  throw new Error(NO_FAILURE_MESSAGE)
}

/**
 * The six failure modes, as a TABLE run through one body.
 *
 * A table and not six separate tests precisely because what is under test is
 * that they are INDISTINGUISHABLE: six bodies would each be free to grow their
 * own assertion, and the account-and-code oracle would come back one
 * maintenance at a time.
 */
const FAILURE_SCENARIOS: ReadonlyArray<
  [name: string, arrange: () => void, overrides: Partial<ConfirmEmailCommand>]
> = [
  ['the email belongs to no account', storeVerifiableAccount, { email: UNKNOWN_EMAIL }],
  ['the account has no active code', storeUser, {}],
  [
    'the code has expired',
    () => {
      storeUser()
      storeVerification({ ageMs: EXPIRED_AGE_MS, attempts: NO_ATTEMPTS_SPENT })
    },
    {},
  ],
  [
    'the attempts are exhausted',
    () => {
      storeUser()
      storeVerification({ ageMs: FRESH_AGE_MS, attempts: MAX_ATTEMPTS })
    },
    {},
  ],
  ['the code is wrong', storeVerifiableAccount, { code: WRONG_CODE }],
  [
    'a concurrent confirm won the race',
    () => {
      storeVerifiableAccount()
      consumeOutcome = LOST_RACE
    },
    {},
  ],
]

describe('ConfirmEmailUseCase', () => {
  it.each(FAILURE_SCENARIOS)(
    'fails identically when %s',
    async (_name, arrange, overrides) => {
      arrange()

      // The MESSAGE and the CODE, not just the type. A branch that threw the
      // same class with "no code for this address" would satisfy an
      // `instanceof` assertion and would still be an oracle: it answers
      // "does this address have an account?" to any anonymous caller.
      expect(await failureFrom(confirm(overrides))).toEqual({
        message: FAILURE_MESSAGE,
        code: FAILURE_CODE,
      })
    },
  )

  it('burns the code, verifies the user and opens a session, in that order', async () => {
    storeVerifiableAccount()

    await confirm()

    // toEqual and not toContain: this single assertion kills a deleted step,
    // any reordering of the three, and — through the trailing COMMIT — any of
    // them escaping the transaction. `toContain` kills none of them.
    expect(callLog).toEqual([CONSUME_CALL, MARK_VERIFIED_CALL, SAVE_TOKEN_CALL, COMMIT])
  })

  it('returns the pair and marks the account verified', async () => {
    storeVerifiableAccount()

    const result = await confirm()

    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE_TOKEN })
    expect(storedUser().emailVerifiedAt).toEqual(NOW)
    expect(storedVerification()?.consumedAt).toEqual(NOW)
  })

  it('signs the access token for the account that was just verified', async () => {
    storeVerifiableAccount()

    await confirm()

    expect(signSpy).toHaveBeenCalledWith({ sub: USER_ID })
  })

  it('spends exactly one attempt on a wrong code, outside the transaction', async () => {
    storeVerifiableAccount()

    await failureFrom(confirm({ code: WRONG_CODE }))

    // Exactly one: a counter incremented twice per guess halves the budget a
    // legitimate user has for a typo.
    expect(incrementAttemptsSpy).toHaveBeenCalledTimes(ONE_CALL)
    expect(storedVerification()?.attempts).toBe(NO_ATTEMPTS_SPENT + ONE_CALL)

    // The whole log, so the absence of COMMIT is asserted rather than assumed:
    // inside a transaction that rolls back — and this path always throws — the
    // brute-force counter would be erased exactly when it matters (§8, line 3).
    expect(callLog).toEqual([INCREMENT_ATTEMPTS_CALL])
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('spends no attempt on a code that was never usable', async () => {
    storeUser()
    storeVerification({ ageMs: EXPIRED_AGE_MS, attempts: NO_ATTEMPTS_SPENT })

    await failureFrom(confirm())

    // The counter exists to price guessing against a LIVE code. Charging an
    // expired one costs the caller nothing and only wears out a row.
    expect(incrementAttemptsSpy).not.toHaveBeenCalled()
    expect(callLog).toEqual([])
  })

  it('leaves the account unverified when the consume race is lost', async () => {
    storeVerifiableAccount()
    consumeOutcome = LOST_RACE

    await failureFrom(confirm())

    // The throw comes from INSIDE the callback precisely so the transaction
    // rolls back: a `return` there would leave the account verified by a code
    // that some other request had already burned, with no session to show for
    // it.
    expect(storedUser().emailVerifiedAt).toBeNull()
    expect(issuedToken()).toBeUndefined()
    expect(callLog).toEqual([CONSUME_CALL])
  })

  it('opens no transaction at all when the address is unknown', async () => {
    storeVerifiableAccount()

    await failureFrom(confirm({ email: UNKNOWN_EMAIL }))

    expect(uowSpy).not.toHaveBeenCalled()
    expect(callLog).toEqual([])
  })

  /**
   * The clock ADVANCES one millisecond per reading, and that is what makes this
   * falsifiable. A fixed stub returns the same instant however many times it is
   * asked, so the test would be green by construction — decoration, by this
   * project's own rule that a test surviving its own mutation is not a test.
   */
  it('reads the clock once, so every write shares one instant', async () => {
    let reading = NOW.getTime()
    const advancingUseCase = buildUseCase({
      now: () => {
        reading += CLOCK_STEP_MS

        return new Date(reading)
      },
    })
    storeVerifiableAccount()

    await advancingUseCase.execute({ email: EMAIL, code: CODE })

    // Three columns across three tables that one transaction makes atomic, and
    // that three clock readings would silently spread apart.
    expect(storedVerification()?.consumedAt).toEqual(storedUser().emailVerifiedAt)
    expect(issuedToken()?.createdAt).toEqual(storedUser().emailVerifiedAt)
    expect(storedUser().updatedAt).toEqual(storedUser().emailVerifiedAt)
  })
})

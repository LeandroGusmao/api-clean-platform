import { beforeEach, describe, expect, it } from 'vitest'
import { EmailVerification } from '#modules/auth/entities/email-verification'
import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import { InMemoryEmailVerificationsRepository } from '#modules/auth/infra/in-memory/in-memory-email-verifications-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { RegisterUserUseCase } from '#modules/auth/use-cases/register-user'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EXISTING_USER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const EXISTING_VERIFICATION_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'
const NOW = new Date('2026-09-03T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const HASH_PREFIX = 'hashed:'
const DIGEST_PREFIX = 'digest:'

const EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = '  JOAO@Example.COM  '
const PASSWORD = 'sup3r-s3cr3t!'
const EXISTING_PASSWORD_HASH = `${HASH_PREFIX}whatever-they-chose`
const INVALID_EMAIL = 'not-an-email'
const WEAK_PASSWORD = 'abcdefghij'

/** Six digits, like the real generator's. Its presence in a body is asserted. */
const CODE = '123456'
const VERIFICATION_TTL_SECONDS = 900
const RESEND_COOLDOWN_MS = 60_000
/** Younger than the cooldown, so a resend must be refused. */
const INSIDE_COOLDOWN_AGE_MS = 1
/**
 * EXACTLY the cooldown, which pins the boundary as exclusive: `now - createdAt
 * < cooldown` refuses, so an age equal to it must send. A test using a
 * comfortably older code would leave `<=` and `<` indistinguishable.
 */
const OUTSIDE_COOLDOWN_AGE_MS = RESEND_COOLDOWN_MS

/**
 * The wire contract of the two templates, spelled out rather than imported:
 * importing them would make the assertion tautological — it would pass whatever
 * `verification-email.ts` happened to say, including the wrong message.
 */
const VERIFICATION_SUBJECT = 'Confirm your email address'
const ALREADY_EXISTS_SUBJECT = 'Someone tried to register with your address'

// Registration never compares or falls back to a decoy; this only exists to
// satisfy IHashProvider's shape.
const UNUSED_DUMMY_HASH = 'unused-by-registration-tests'

const USER_MISSING_MESSAGE = 'the repository stored no user'
const NOT_A_COLLISION_MESSAGE = 'boom — a failure that is not a collision'

/** Anything the `catch` must NOT recognise. */
class NotACollisionError extends Error {}

/** Records the order in which collaborators were touched. */
const USERS_SAVE = 'users.save'
const USERS_UPDATE_PASSWORD_HASH = 'users.updatePasswordHash'
const VERIFICATIONS_INVALIDATE = 'verifications.invalidateActiveForUser'
const VERIFICATIONS_SAVE = 'verifications.save'
const COMMIT = 'COMMIT'
const EMAIL_SEND = 'email.send'

/** The password chosen by whoever sends the SECOND, colliding request. */
const NEW_PASSWORD = 'a-different-s3cret!'

// One-method ports do not deserve their own file: an object literal here keeps
// the double next to the assertions it serves, and out of `dist/`.
const clock: IClock = { now: () => NOW }
const idGenerator: IIdGenerator = { generate: () => ID }

let hashedPlaintexts: string[]

// Records rather than just returning, so a test can assert that hashing did
// NOT happen. A literal that only returns cannot prove absence.
const hashProvider: IHashProvider = {
  hash: (plain) => {
    hashedPlaintexts.push(plain)
    return Promise.resolve(`${HASH_PREFIX}${plain}`)
  },
  compare: () => Promise.resolve(false),
  dummyHash: UNUSED_DUMMY_HASH,
}

let callLog: string[]
let sent: EmailMessage[]
let usersRepository: InMemoryUsersRepository
let verificationsRepository: InMemoryEmailVerificationsRepository
let emailSender: IEmailSender
let issuer: EmailVerificationIssuer
let useCase: RegisterUserUseCase

/**
 * The repositories as the transaction hands them out, wrapping the SAME
 * in-memory instances the use case reads directly — one database, two handles,
 * which is what makes the collision path see the row the failed insert raced
 * against.
 */
function trackedRepos(): AuthRepos {
  return {
    users: {
      save: async (user) => {
        await usersRepository.save(user)

        // Logged AFTER the delegate, not before: a save that throws is the
        // collision path, and recording it there would make the collision log
        // indistinguishable from the success log.
        callLog.push(USERS_SAVE)
      },
      findByEmail: (email) => usersRepository.findByEmail(email),
      findById: (id) => usersRepository.findById(id),
      updatePasswordHash: async (id, passwordHash, updatedAt) => {
        await usersRepository.updatePasswordHash(id, passwordHash, updatedAt)

        // Logged AFTER the delegate, matching `USERS_SAVE`'s convention above:
        // this write is what the hijack fix binds to `issueFor` in the same
        // transaction, and the call-log order is the proof of that binding.
        callLog.push(USERS_UPDATE_PASSWORD_HASH)
      },
      markEmailVerified: (id, verifiedAt, updatedAt) =>
        usersRepository.markEmailVerified(id, verifiedAt, updatedAt),
    },
    refreshTokens: {
      // Nothing in this suite touches refresh tokens; the shape only has to
      // satisfy AuthRepos.
      save: async () => {},
      findByHashForUpdate: async () => null,
      markRotated: async () => {},
      revoke: async () => {},
      revokeFamily: async () => {},
      revokeAllForUser: async () => {},
    },
    emailVerifications: {
      save: (verification) => {
        callLog.push(VERIFICATIONS_SAVE)
        return verificationsRepository.save(verification)
      },
      findActiveByUserId: (userId) => verificationsRepository.findActiveByUserId(userId),
      invalidateActiveForUser: (userId, at) => {
        callLog.push(VERIFICATIONS_INVALIDATE)
        return verificationsRepository.invalidateActiveForUser(userId, at)
      },
      registerFailedAttempt: (id, maxAttempts) =>
        verificationsRepository.registerFailedAttempt(id, maxAttempts),
      consume: (id, at) => verificationsRepository.consume(id, at),
    },
  }
}

/**
 * The `uow` fake appends `COMMIT` when — and only when — the callback resolves.
 * That marker is what turns the order assertion below into a statement about
 * §8: a send recorded before it would be a send inside the transaction.
 */
function committingUow(): IAuthUnitOfWork {
  const repos = trackedRepos()

  const uow = async (work: (repos: AuthRepos) => Promise<unknown>) => {
    const result = await work(repos)
    callLog.push(COMMIT)

    return result
  }

  // Cast because `IAuthUnitOfWork` is generic in the callback's return type and
  // a plain function cannot be generic here. Only the generic instantiation is
  // waived; the callback's parameter type is still checked above.
  return uow as unknown as IAuthUnitOfWork
}

function buildUseCase(uow: IAuthUnitOfWork): RegisterUserUseCase {
  return new RegisterUserUseCase(
    usersRepository,
    verificationsRepository,
    uow,
    issuer,
    emailSender,
    hashProvider,
    clock,
    idGenerator,
    RESEND_COOLDOWN_MS,
  )
}

beforeEach(() => {
  hashedPlaintexts = []
  callLog = []
  sent = []
  usersRepository = new InMemoryUsersRepository()
  verificationsRepository = new InMemoryEmailVerificationsRepository()

  emailSender = {
    send: async (message) => {
      callLog.push(EMAIL_SEND)
      sent.push(message)
    },
  }

  // The REAL issuer, not a double: what is under test here is that the use case
  // defers the send it is handed, and a fake issuer would let the use case pass
  // while the deferral it depends on was gone.
  issuer = new EmailVerificationIssuer(
    emailSender,
    { opaque: () => CODE, numericCode: () => CODE },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    idGenerator,
    VERIFICATION_TTL_SECONDS,
  )

  useCase = buildUseCase(committingUow())
})

function storedUser() {
  const [user] = usersRepository.users
  if (user === undefined) throw new Error(USER_MISSING_MESSAGE)
  return user
}

function storeExistingUser(emailVerifiedAt: Date | null) {
  usersRepository.users.push(
    User.fromTrusted({
      id: EXISTING_USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: EXISTING_PASSWORD_HASH,
      emailVerifiedAt,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

function storeActiveVerification(ageMs: number) {
  verificationsRepository.verifications.push(
    EmailVerification.create({
      id: EXISTING_VERIFICATION_ID,
      userId: EXISTING_USER_ID,
      codeHash: `${DIGEST_PREFIX}${CODE}`,
      now: new Date(NOW.getTime() - ageMs),
      ttlSeconds: VERIFICATION_TTL_SECONDS,
    }),
  )
}

describe('RegisterUserUseCase', () => {
  it('persists the user and the code, commits, and only then sends', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    // toEqual and not toContain: this single assertion kills a deleted
    // `deliver()`, a send moved inside the callback, and any reordering of the
    // three writes. `toContain` kills none of them.
    expect(callLog).toEqual([
      USERS_SAVE,
      VERIFICATIONS_INVALIDATE,
      VERIFICATIONS_SAVE,
      COMMIT,
      EMAIL_SEND,
    ])
  })

  it('resolves with nothing: the id was the old oracle', async () => {
    // `RegisterUserResult` is gone. Handing an id back to an anonymous caller
    // is the same disclosure the 409 was, one indirection away.
    await expect(
      useCase.execute({ email: EMAIL, password: PASSWORD }),
    ).resolves.toBeUndefined()
    expect(usersRepository.users).toHaveLength(1)
  })

  it('emails the verification code to the new address', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL)
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
    expect(sent[0]?.text).toContain(CODE)
  })

  it('stores only the digest of the code, never the code', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    const [verification] = verificationsRepository.verifications
    expect(verification?.codeHash).toBe(`${DIGEST_PREFIX}${CODE}`)
  })

  it('normalizes the email before storing it', async () => {
    await useCase.execute({ email: MIXED_CASE_EMAIL, password: PASSWORD })

    // Normalization is what makes the stored value match the functional unique
    // index on `lower(email)`.
    expect(storedUser().email.value).toBe(EMAIL)
  })

  it('stores the hash, never the plaintext', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(storedUser().passwordHash).toBe(`${HASH_PREFIX}${PASSWORD}`)
  })

  it('takes the id from the generator and the timestamps from the clock', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })
    const user = storedUser()

    // R7: nothing in the pure layer produces these on its own.
    expect(user.id).toBe(ID)
    expect(user.createdAt).toEqual(NOW)
    expect(user.updatedAt).toEqual(NOW)
  })

  it('stamps the code with the same instant as the user', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    // The clock is read ONCE per execution — R7. One instant across both rows.
    expect(verificationsRepository.verifications[0]?.createdAt).toEqual(
      storedUser().createdAt,
    )
  })

  it('emails a fresh code when the address has an UNVERIFIED account', async () => {
    storeExistingUser(null)

    await useCase.execute({ email: EMAIL, password: PASSWORD })

    // Registering again IS resending. Without this branch, someone who lost the
    // first email would be told an account exists and would be stuck forever.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
    expect(sent[0]?.text).toContain(CODE)
    // The failed insert left nothing behind, and the new code belongs to the
    // account that was already there.
    expect(usersRepository.users).toHaveLength(1)
    expect(verificationsRepository.verifications[0]?.userId).toBe(EXISTING_USER_ID)
    // The security fix, pinned directly: whoever's registration attempt wins
    // the live code also owns the stored password. `EXISTING_PASSWORD_HASH`
    // belonged to whoever created the row first; it must not survive.
    expect(storedUser().passwordHash).toBe(`${HASH_PREFIX}${PASSWORD}`)
    // The send still happens after the second transaction commits, exactly as
    // on the success path. `USERS_SAVE` is absent because the insert failed —
    // `USERS_UPDATE_PASSWORD_HASH` replaces it, in the SAME transaction as the
    // code it is bound to.
    expect(callLog).toEqual([
      USERS_UPDATE_PASSWORD_HASH,
      VERIFICATIONS_INVALIDATE,
      VERIFICATIONS_SAVE,
      COMMIT,
      EMAIL_SEND,
    ])
  })

  it('resends once an unverified account leaves the cooldown', async () => {
    storeExistingUser(null)
    storeActiveVerification(OUTSIDE_COOLDOWN_AGE_MS)

    await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
  })

  it('emails "you already have an account" when the address is VERIFIED', async () => {
    storeExistingUser(NOW)

    await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL)
    expect(sent[0]?.subject).toBe(ALREADY_EXISTS_SUBJECT)
    // No code, and no new code minted: a stranger's request must not be able to
    // put a live credential in a verified owner's inbox.
    expect(sent[0]?.text).not.toContain(CODE)
    expect(verificationsRepository.verifications).toHaveLength(0)
    // A verified account has a PROVEN owner. The whole point of this email is
    // that nothing about the account changes — including, and especially, its
    // password.
    expect(storedUser().passwordHash).toBe(EXISTING_PASSWORD_HASH)
    expect(callLog).toEqual([EMAIL_SEND])
  })

  it('sends nothing when an unverified account got a code inside the cooldown', async () => {
    storeExistingUser(null)
    storeActiveVerification(INSIDE_COOLDOWN_AGE_MS)

    await useCase.execute({ email: EMAIL, password: NEW_PASSWORD })

    // The cooldown is what stops registration from being used to flood a
    // stranger's inbox, and from minting fresh attempt budget on demand.
    expect(sent).toHaveLength(0)
    expect(verificationsRepository.verifications).toHaveLength(1)
    expect(callLog).toEqual([])
    // This is the test that pins the reasoning behind the security fix: the
    // cooldown branch issues NO fresh code, so it must write NO password hash
    // either. Writing it here would decouple the password from the live code
    // — an attacker registering inside the victim's cooldown would set THEIR
    // password onto a code already sitting in the victim's inbox, which is the
    // same hijack with the roles swapped. A later "cleanup" that moves this
    // write out of the issuing branch must fail this assertion.
    expect(storedUser().passwordHash).toBe(EXISTING_PASSWORD_HASH)
  })

  it('sends nothing when the row vanished between the violation and the read', async () => {
    // The insert loses to a concurrent one, which is then deleted before the
    // collision path can read it. Nothing is left to tell anything about — and
    // the response still may not say so, so this resolves like every other path.
    const collidingUow = (async () => {
      throw new EmailAlreadyInUseError()
    }) as unknown as IAuthUnitOfWork

    await expect(
      buildUseCase(collidingUow).execute({ email: EMAIL, password: PASSWORD }),
    ).resolves.toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  it('answers the same way whether the address is free or taken', async () => {
    const free = await useCase.execute({ email: EMAIL, password: PASSWORD })
    const taken = await useCase.execute({ email: EMAIL, password: PASSWORD })

    // Identical resolutions. The whole point of the 202: the response carries
    // nothing an anonymous caller could use to tell the two cases apart.
    expect(free).toBe(taken)
    expect(taken).toBeUndefined()
  })

  it('lets an error that is NOT EmailAlreadyInUseError propagate', async () => {
    const failingUow = (async () => {
      throw new NotACollisionError(NOT_A_COLLISION_MESSAGE)
    }) as unknown as IAuthUnitOfWork

    // A bare `catch` would turn a deadlock, a dead connection or a bug into a
    // silent 202: the caller told the registration was accepted, and nothing
    // written.
    await expect(
      buildUseCase(failingUow).execute({ email: EMAIL, password: PASSWORD }),
    ).rejects.toBeInstanceOf(NotACollisionError)
    expect(sent).toHaveLength(0)
  })

  it('rejects an invalid email before hashing anything', async () => {
    await expect(
      useCase.execute({ email: INVALID_EMAIL, password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidEmailError)

    // The reason the value objects run first: argon2 costs ~100ms, and an
    // invalid payload must not pay it. Without this assertion, reordering the
    // use case to hash first would keep every test in this file green.
    expect(hashedPlaintexts).toHaveLength(0)
    expect(usersRepository.users).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('rejects a password that breaks the policy before hashing anything', async () => {
    await expect(
      useCase.execute({ email: EMAIL, password: WEAK_PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidPasswordError)

    expect(hashedPlaintexts).toHaveLength(0)
    expect(usersRepository.users).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})

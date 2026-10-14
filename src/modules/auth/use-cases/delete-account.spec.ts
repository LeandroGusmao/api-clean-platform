import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { accountDeletedEmail } from '#modules/auth/emails/messages'
import { AuditEventType } from '#modules/auth/entities/audit-event'
import { User } from '#modules/auth/entities/user'
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import { InMemoryAuditEventsRepository } from '#modules/auth/infra/in-memory/in-memory-audit-events-repository'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import { noopAuthRepos } from '#modules/auth/repositories/noop-auth-repos'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { DeleteAccountUseCase } from '#modules/auth/use-cases/delete-account'
import { Email } from '#modules/auth/value-objects/email'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const MISSING_USER_ID = '00000000-0000-4000-8000-000000000000'
const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WRONG_PASSWORD = 'n0t-the-one!'

const HASH_PREFIX = 'hashed:'
const STORED_HASH = `${HASH_PREFIX}${PASSWORD}`
const DUMMY_HASH = `${HASH_PREFIX}dummy`
const GENERATED_ID = 'generated-id'
const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const
const ONE_EVENT = 1
const NO_EVENTS = 0

const NOW = new Date('2026-09-18T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')

/** Records the order in which collaborators were called. */
const COMPARE_CALL = 'compare'
const UOW_CALL = 'uow'
const DELETE_USER_CALL = 'deleteById'
const SWEEP_PENDINGS_CALL = 'deleteAllByEmail'
const SAVE_OUTBOX_CALL = 'saveOutboxMessage'
/** Pushed by the `uow` fake only when its callback RESOLVES — never on a rollback. */
const COMMIT_CALL = 'commit'

const NO_MESSAGES = 0
const NO_USERS = 0
const ONE_MESSAGE = 1
const ONE_USER = 1

let callLog: string[]
let usersRepository: InMemoryUsersRepository
let outboxMessages: InMemoryOutboxMessagesRepository
let auditEventsRepository: InMemoryAuditEventsRepository
let compareResult: boolean
let deleteAllByEmailSpy: Mock<(email: Email) => Promise<void>>
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>
let useCase: DeleteAccountUseCase

const hashProvider: IHashProvider = {
  hash: async () => STORED_HASH,
  compare: async () => {
    callLog.push(COMPARE_CALL)
    return compareResult
  },
  dummyHash: DUMMY_HASH,
}

const storeUser = (passwordHash: string | null) =>
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash,
      emailVerifiedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )

beforeEach(() => {
  callLog = []
  compareResult = true
  usersRepository = new InMemoryUsersRepository()
  outboxMessages = new InMemoryOutboxMessagesRepository()
  auditEventsRepository = new InMemoryAuditEventsRepository()
  deleteAllByEmailSpy = vi.fn(async () => {
    callLog.push(SWEEP_PENDINGS_CALL)
  })

  uowSpy = vi.fn(async (work) => {
    callLog.push(UOW_CALL)
    const repos: AuthRepos = {
      ...noopAuthRepos(),
      auditEvents: auditEventsRepository,
      users: {
        ...noopAuthRepos().users,
        deleteById: (id) => {
          callLog.push(DELETE_USER_CALL)
          return usersRepository.deleteById(id)
        },
      },
      pendingRegistrations: {
        ...noopAuthRepos().pendingRegistrations,
        deleteAllByEmail: deleteAllByEmailSpy,
      },
      outboxMessages: {
        ...noopAuthRepos().outboxMessages,
        save: (message) => {
          callLog.push(SAVE_OUTBOX_CALL)
          return outboxMessages.save(message)
        },
      },
    }
    const result = await work(repos)
    callLog.push(COMMIT_CALL)
    return result
  })

  useCase = new DeleteAccountUseCase(
    usersRepository,
    // Cast: `IAuthUnitOfWork` is generic in the callback's return type and
    // `vi.fn` cannot produce a generic function. The spy's own signature is
    // checked at its declaration; only the generic instantiation is waived.
    uowSpy as unknown as IAuthUnitOfWork,
    hashProvider,
    { now: () => NOW },
    { generate: () => GENERATED_ID },
  )
})

describe('DeleteAccountUseCase — account with a password', () => {
  it('deletes the user, sweeps the pendings and queues the notice in one uow', async () => {
    storeUser(STORED_HASH)

    await useCase.execute({ userId: USER_ID, password: PASSWORD, device: DEVICE })

    // toEqual on the whole log: argon2 must run before the transaction opens,
    // and all three writes must land inside it.
    expect(callLog).toEqual([
      COMPARE_CALL,
      UOW_CALL,
      DELETE_USER_CALL,
      SWEEP_PENDINGS_CALL,
      SAVE_OUTBOX_CALL,
      COMMIT_CALL,
    ])
    expect(usersRepository.users).toHaveLength(NO_USERS)
  })

  it('sweeps the pendings of the STORED address', async () => {
    storeUser(STORED_HASH)

    await useCase.execute({ userId: USER_ID, password: PASSWORD, device: DEVICE })

    expect(deleteAllByEmailSpy).toHaveBeenCalledWith(Email.fromTrusted(EMAIL))
  })

  it('queues the deletion notice addressed to the owner', async () => {
    storeUser(STORED_HASH)

    await useCase.execute({ userId: USER_ID, password: PASSWORD, device: DEVICE })

    expect(outboxMessages.messages).toHaveLength(ONE_MESSAGE)
    expect(outboxMessages.messages[0]?.toEmailMessage()).toEqual(
      accountDeletedEmail(Email.fromTrusted(EMAIL)),
    )
  })

  it('refuses a wrong password without opening a transaction', async () => {
    storeUser(STORED_HASH)
    compareResult = false

    await expect(
      useCase.execute({ userId: USER_ID, password: WRONG_PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCurrentPasswordError)
    expect(uowSpy).not.toHaveBeenCalled()
    expect(usersRepository.users).toHaveLength(ONE_USER)
  })

  it('refuses when no password is sent at all', async () => {
    storeUser(STORED_HASH)

    await expect(
      useCase.execute({ userId: USER_ID, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCurrentPasswordError)
    expect(uowSpy).not.toHaveBeenCalled()
  })
})

describe('DeleteAccountUseCase — federated-only account', () => {
  it('deletes with no password at all, and never runs argon2', async () => {
    storeUser(null)

    await useCase.execute({ userId: USER_ID, device: DEVICE })

    expect(callLog).not.toContain(COMPARE_CALL)
    expect(usersRepository.users).toHaveLength(NO_USERS)
  })
})

describe('DeleteAccountUseCase — unknown subject', () => {
  it('throws when the token subject has no row, writing nothing', async () => {
    await expect(
      useCase.execute({ userId: MISSING_USER_ID, device: DEVICE }),
    ).rejects.toBeInstanceOf(UserNotFoundError)
    expect(uowSpy).not.toHaveBeenCalled()
    expect(outboxMessages.messages).toHaveLength(NO_MESSAGES)
  })
})

describe('DeleteAccountUseCase — audit trail', () => {
  it('records an ACCOUNT_DELETED audit event with the device that asked', async () => {
    storeUser(STORED_HASH)

    await useCase.execute({ userId: USER_ID, password: PASSWORD, device: DEVICE })

    expect(auditEventsRepository.events).toHaveLength(ONE_EVENT)
    const [event] = auditEventsRepository.events
    expect(event?.type).toBe(AuditEventType.AccountDeleted)
    expect(event?.userId).toBe(USER_ID)
    expect(event?.ip).toBe(DEVICE.ip)
    expect(event?.deviceLabel).toBe(DEVICE.label)
    expect(event?.occurredAt).toEqual(NOW)
  })

  it('records nothing when the password is wrong', async () => {
    storeUser(STORED_HASH)
    compareResult = false

    await expect(
      useCase.execute({ userId: USER_ID, password: WRONG_PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCurrentPasswordError)

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })

  it('records nothing when the account does not exist', async () => {
    await expect(
      useCase.execute({ userId: MISSING_USER_ID, device: DEVICE }),
    ).rejects.toBeInstanceOf(UserNotFoundError)

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })
})

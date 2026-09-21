import { beforeEach, describe, expect, it } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import { GetUserProfileUseCase } from '#modules/auth/use-cases/get-user-profile'
import { Email } from '#modules/auth/value-objects/email'

const EMAIL = 'joao@example.com'
const PASSWORD_HASH = 'hashed:sup3r-s3cr3t!'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const MISSING_USER_ID = '00000000-0000-4000-8000-000000000000'
const NOW = new Date('2026-08-27T12:00:00.000Z')

let usersRepository: InMemoryUsersRepository
let useCase: GetUserProfileUseCase

beforeEach(async () => {
  usersRepository = new InMemoryUsersRepository()
  useCase = new GetUserProfileUseCase(usersRepository)

  await usersRepository.save(
    User.create({
      id: USER_ID,
      email: Email.create(EMAIL),
      passwordHash: PASSWORD_HASH,
      now: NOW,
    }),
  )
})

describe('GetUserProfileUseCase', () => {
  it('returns a flat result, not the entity', async () => {
    // The value object is unwrapped HERE, so no consumer has to know that
    // `User.email` is an `Email` rather than a string. Timestamps stay `Date`:
    // formatting them is the transport's job, and a worker consuming this use
    // case would have to parse an ISO string back.
    const profile = await useCase.execute(USER_ID)

    expect(profile).toEqual({
      id: USER_ID,
      email: EMAIL,
      // `User.create` is born verified; the point here is the
      // FLAT shape, not the verification state.
      emailVerifiedAt: NOW,
      createdAt: NOW,
    })
  })

  it('throws when the subject of a valid token has no row', async () => {
    // Reachable in production: the account was deleted while a still-unexpired
    // token was in the wild.
    await expect(useCase.execute(MISSING_USER_ID)).rejects.toBeInstanceOf(
      UserNotFoundError,
    )
  })
})

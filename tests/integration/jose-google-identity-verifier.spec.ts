import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvalidGoogleIdentityError } from '#modules/auth/errors/invalid-google-identity-error'
import { JoseGoogleIdentityVerifier } from '#modules/auth/infra/providers/jose-google-identity-verifier'
import { type GoogleJwksServer, startGoogleJwksServer } from './setup/google-jwks.js'

const CLIENT_ID = 'integration-test-google-client-id'
const DEFAULT_SUBJECT = 'google-subject-1234567890'
const DEFAULT_EMAIL = 'ana@example.com'
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000

let jwks: GoogleJwksServer
let verifier: JoseGoogleIdentityVerifier

beforeAll(async () => {
  jwks = await startGoogleJwksServer(CLIENT_ID)
  verifier = new JoseGoogleIdentityVerifier({
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_JWKS_URI: jwks.url,
  })
})

afterAll(async () => {
  await jwks.close()
})

describe('JoseGoogleIdentityVerifier.verify', () => {
  it('returns the subject and email of a well-formed token', async () => {
    const token = await jwks.sign()

    const identity = await verifier.verify(token)

    expect(identity.subject).toBe(DEFAULT_SUBJECT)
    expect(identity.email).toBe(DEFAULT_EMAIL)
  })

  it('rejects a token minted for a different client id', async () => {
    const token = await jwks.sign({
      aud: 'some-other-client.apps.googleusercontent.com',
    })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects a token from an unexpected issuer', async () => {
    const token = await jwks.sign({ iss: 'https://evil.example.com' })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / MS_PER_SECOND) - SECONDS_PER_MINUTE

    const token = await jwks.sign({ exp: past })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects a token signed with a key that is not in the JWKS', async () => {
    const token = await jwks.signWithForeignKey()

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects a token whose email is not verified by Google', async () => {
    const token = await jwks.sign({ email_verified: false })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects a token with no email claim', async () => {
    const token = await jwks.sign({ email: undefined })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })
})

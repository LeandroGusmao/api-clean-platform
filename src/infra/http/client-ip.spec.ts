import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  clientIpKey,
  parsedClientIp,
  UNPARSEABLE_CLIENT_IP_KEY,
} from '#infra/http/client-ip'

/** Only `ip` is read, so a literal stands in for the request — no server, no I/O. */
const requestWithIp = (ip: string) => ({ ip }) as FastifyRequest

const LONG_FORGED_IP = 'A'.repeat(200)
/** The longest a textual IPv6 address can be. */
const MAX_ADDRESS_LENGTH = 45

/**
 * Measured on Fastify 5.12.1: with a trusted peer, `request.ip` is the last
 * X-Forwarded-For token verbatim, so every one of these is a value the client
 * can put there.
 */
const FORGED_IPS: ReadonlyArray<[string, string]> = [
  ['a bare word', 'naoehip'],
  ['an address with a trailing character', '1.2.3.4a'],
  ['octets out of range', '999.999.999.999'],
  ['an address carrying a port', '1.2.3.4:5678'],
  ['two hundred characters', LONG_FORGED_IP],
  ['an empty string', ''],
]

describe('clientIpKey', () => {
  it('keeps a valid IPv4 address', () => {
    expect(clientIpKey(requestWithIp('203.0.113.7'))).toBe('203.0.113.7')
  })

  // @fastify/rate-limit's own key generator groups IPv6 by /64, and replacing
  // it would throw that away. A single subscriber owns 2^64 addresses, so
  // per-address keying gives them unlimited buckets and limits nothing.
  it('groups IPv6 addresses by their /64, case-insensitively', () => {
    const first = clientIpKey(requestWithIp('2001:DB8:0:1::5'))
    const second = clientIpKey(requestWithIp('2001:db8:0:1::99'))

    expect(first).toBe(second)
  })

  it('keeps a different IPv6 /64 in a different bucket', () => {
    const first = clientIpKey(requestWithIp('2001:db8:0:1::5'))
    const second = clientIpKey(requestWithIp('2001:db8:0:2::5'))

    expect(first).not.toBe(second)
  })

  it.each(FORGED_IPS)('collapses %s into a single bucket', (_label, forged) => {
    expect(clientIpKey(requestWithIp(forged))).toBe(UNPARSEABLE_CLIENT_IP_KEY)
  })

  // The width matters as much as the count: without validation the attacker
  // chooses how many bytes every store entry costs.
  it('never produces a key wider than an address', () => {
    expect(clientIpKey(requestWithIp(LONG_FORGED_IP)).length).toBeLessThanOrEqual(
      MAX_ADDRESS_LENGTH,
    )
  })
})

describe('parsedClientIp', () => {
  it('normalises a usable address exactly as the key generator does', () => {
    // The two share one validation on purpose: an address that counts against
    // the rate limit and an address stored on a session must not disagree.
    expect(parsedClientIp(requestWithIp('2001:DB8:0:1::5'))).toBe(
      clientIpKey(requestWithIp('2001:DB8:0:1::5')),
    )
  })

  it.each(FORGED_IPS)('reports %s as no address at all', (_label, forged) => {
    // Where the key generator returns the shared bucket, this returns null:
    // "one bucket" is a rate-limit meaning, and it does not survive being
    // written to a column and rendered back to an account owner.
    expect(parsedClientIp(requestWithIp(forged))).toBeNull()
  })
})

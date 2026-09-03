import { normalizeIP } from '@fastify/rate-limit'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'

/**
 * The one bucket every unusable value shares.
 *
 * A single constant rather than the socket address: falling back to the peer
 * would put every client behind the proxy into one bucket, which is the very
 * thing this exists to prevent.
 */
export const UNPARSEABLE_CLIENT_IP_KEY = 'unparseable-client-ip'

const clientIpSchema = z.union([z.ipv4(), z.ipv6()])

/**
 * The rate limit key for a request, and the only place `request.ip` becomes one.
 *
 * `request.ip` is NOT guaranteed to be an address. Measured on Fastify 5.12.1:
 * with a trusted peer it returns the last `X-Forwarded-For` token verbatim —
 * `naoehip`, `999.999.999.999`, 200 characters of `A`. It is attacker-chosen
 * text, so a store keyed on it lets the attacker pick both how many entries
 * exist and how many bytes each one costs.
 *
 * Two steps, and both are load-bearing:
 *
 * 1. **Validate.** Anything malformed collapses to ONE bucket, so a client
 *    forging addresses throttles itself and the keyspace it can open stays at
 *    one. This also bounds the width, an address being at most 45 characters.
 * 2. **Normalize.** Replacing the plugin's `keyGenerator` discards the
 *    `normalizeIP` it would otherwise apply, and that default groups IPv6 by
 *    /64. Without it a subscriber's 2^64 addresses are 2^64 free buckets, and
 *    the limiter does not limit IPv6 clients at all.
 */
export function clientIpKey(request: FastifyRequest): string {
  const parsed = clientIpSchema.safeParse(request.ip)

  return parsed.success ? normalizeIP(parsed.data) : UNPARSEABLE_CLIENT_IP_KEY
}

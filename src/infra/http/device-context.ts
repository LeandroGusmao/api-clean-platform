import Bowser from 'bowser'
import type { FastifyRequest } from 'fastify'
import { parsedClientIp } from './client-ip.js'

/**
 * What the owner sees when the User-Agent names nothing recognisable.
 *
 * A named value rather than `null`, because on the row `null` means the line is
 * older than the column — and "we could not identify this device" has to stay
 * distinguishable from "we never recorded one".
 */
export const UNKNOWN_DEVICE_LABEL = 'Unknown device'

/**
 * The header is text chosen by the client, and not every parser output is
 * short. Bounds what reaches a column that is rendered back to the owner.
 */
export const MAX_DEVICE_LABEL_LENGTH = 64

const USER_AGENT_HEADER = 'user-agent'
const LABEL_SEPARATOR = ' on '

/** What a session row records about the client that opened it. */
export interface DeviceContext {
  /** Null when the address did not parse — see `parsedClientIp`. */
  ip: string | null
  label: string
}

function labelFor(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent.length === 0) return UNKNOWN_DEVICE_LABEL

  const { browser, os } = Bowser.parse(userAgent)

  if (browser.name === undefined || os.name === undefined) return UNKNOWN_DEVICE_LABEL

  return `${browser.name}${LABEL_SEPARATOR}${os.name}`.slice(0, MAX_DEVICE_LABEL_LENGTH)
}

/**
 * The only place a request becomes session context, for the same reason
 * `clientIpKey` is the only place `request.ip` becomes a rate-limit key: the
 * conversion has rules, and a second copy of them is a second thing to get
 * wrong.
 *
 * The raw User-Agent is deliberately not returned.
 */
export function buildDeviceContext(request: FastifyRequest): DeviceContext {
  return {
    ip: parsedClientIp(request),
    label: labelFor(request.headers[USER_AGENT_HEADER]),
  }
}

import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { UNPARSEABLE_CLIENT_IP_KEY } from '#infra/http/client-ip'
import {
  buildDeviceContext,
  MAX_DEVICE_LABEL_LENGTH,
  UNKNOWN_DEVICE_LABEL,
} from '#infra/http/device-context'

const IP = '203.0.113.7'
const UNPARSEABLE_IP = 'not-an-ip'

const CHROME_ON_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like ' +
  'Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const SAFARI_ON_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const NOT_A_USER_AGENT = 'not-a-user-agent'
const OVERSIZED_USER_AGENT_LENGTH = 4096
const OVERSIZED_USER_AGENT = 'A'.repeat(OVERSIZED_USER_AGENT_LENGTH)

const EMPTY_USER_AGENT = ''

const requestWith = (ip: string, userAgent?: string) =>
  ({
    ip,
    headers: userAgent === undefined ? {} : { 'user-agent': userAgent },
  }) as unknown as FastifyRequest

describe('buildDeviceContext label', () => {
  it('names the browser and the operating system', () => {
    expect(buildDeviceContext(requestWith(IP, CHROME_ON_ANDROID)).label).toBe(
      'Chrome on Android',
    )
  })

  it('names them on iOS too', () => {
    expect(buildDeviceContext(requestWith(IP, SAFARI_ON_IOS)).label).toBe('Safari on iOS')
  })

  it('falls back when the header is absent', () => {
    expect(buildDeviceContext(requestWith(IP)).label).toBe(UNKNOWN_DEVICE_LABEL)
  })

  it('falls back when the header is empty', () => {
    expect(buildDeviceContext(requestWith(IP, EMPTY_USER_AGENT)).label).toBe(
      UNKNOWN_DEVICE_LABEL,
    )
  })

  it('falls back when the header is not a User-Agent at all', () => {
    expect(buildDeviceContext(requestWith(IP, NOT_A_USER_AGENT)).label).toBe(
      UNKNOWN_DEVICE_LABEL,
    )
  })

  it('bounds the label, the header being chosen by the client', () => {
    const { label } = buildDeviceContext(requestWith(IP, OVERSIZED_USER_AGENT))

    expect(label.length).toBeLessThanOrEqual(MAX_DEVICE_LABEL_LENGTH)
  })
})

describe('buildDeviceContext address', () => {
  it('takes the address through the validating helper', () => {
    expect(buildDeviceContext(requestWith(IP, CHROME_ON_ANDROID)).ip).toBe(IP)
  })

  it('collapses an unusable address onto the shared sentinel', () => {
    expect(buildDeviceContext(requestWith(UNPARSEABLE_IP, CHROME_ON_ANDROID)).ip).toBe(
      UNPARSEABLE_CLIENT_IP_KEY,
    )
  })
})

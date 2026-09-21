import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

export const REFRESH_COOKIE_NAME = 'refresh_token'

/**
 * `/auth`, and NOT the narrower `/auth/refresh`.
 *
 * A browser sends a cookie only to paths at or below `Path`, so the narrower
 * value never reaches `POST /auth/logout` — which would make cookie-mode logout
 * unimplementable. The cost is the cookie also travelling to `/auth/login` and
 * `/auth/register`, which ignore it; it stays HttpOnly, Secure and
 * SameSite=Strict throughout, and `headers.cookie` is already redacted from the
 * logs.
 */
const REFRESH_COOKIE_PATH = '/auth'

export const REFRESH_TRANSPORT_BODY = 'body'
export const REFRESH_TRANSPORT_COOKIE = 'cookie'

/**
 * Which channel carries the refresh token back. Needed by the three endpoints
 * that hand out a refresh token WITHOUT having received one — `login`,
 * `change-password` and `confirm-email` — because nothing in their requests
 * reveals the channel. `refresh` and `logout` learn it from the token that
 * arrived.
 *
 * Not the market default — Firebase, Supabase, Cognito and Auth0 all answer in
 * the body and leave cookies to a BFF. Putting the cookie in the API itself is
 * deliberate: one surface serves both clients, and process-level configuration
 * cannot decide it, because both clients hit the same process.
 */
export const refreshTransportSchema = z
  .enum([REFRESH_TRANSPORT_BODY, REFRESH_TRANSPORT_COOKIE])
  .default(REFRESH_TRANSPORT_BODY)

/**
 * `Secure` is on in EVERY environment, development included, and deliberately
 * not keyed on `NODE_ENV`: that variable carries `.default('development')` in
 * `env.ts`, so a deploy that forgets to set it would ship this cookie without
 * `Secure` — in silence. A security attribute that fails open on a missing
 * variable is the wrong trade at any price.
 *
 * **The price, and it is measured, not feared. Safari refuses a `Secure`
 * cookie even on `http://localhost`.** Probed 2026-09-01 with exactly these
 * attributes, against a pair of cookies differing only by `Secure`:
 *
 * | Client | Origin | `Secure` | Control |
 * |---|---|---|---|
 * | Safari, macOS | `http://localhost` | REFUSED | stored |
 * | Safari, iOS 18.7 | `http://192.168.x.x` | REFUSED | stored |
 * | Chrome, Linux | `http://localhost` | accepted | stored |
 * | Firefox 154, Linux | `http://localhost` | accepted | stored |
 *
 * So it is WebKit specifically, not "plain HTTP", that refuses: Gecko and Blink
 * both accept the same cookie at the same origin. The control coming back
 * everywhere is what makes the attribution clean — it carries `SameSite=Strict`,
 * `Path=/auth` and `HttpOnly`, so those three are fine in WebKit and only
 * `Secure` is refused.
 *
 * Consequence: cookie mode cannot be exercised from Safari in development,
 * because `/docs` is development-only and served over `http://localhost`. Use a
 * Chromium browser, or terminate TLS in front of the API. Testing from a real
 * device over a LAN IP fails the same way in EVERY browser, since a bare LAN
 * address is never a trustworthy origin.
 *
 * The failure is silent in both cases: nothing is stored, nothing is warned,
 * and the next refresh answers 401 exactly as if no one had logged in.
 *
 * Production is unaffected (HTTPS), and so is mobile — a native client never
 * asks for this cookie; it takes the token in the body and stores
 * it in the Keychain or Keystore.
 */
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: REFRESH_COOKIE_PATH,
} as const

export function readRefreshCookie(request: FastifyRequest): string | undefined {
  return request.cookies[REFRESH_COOKIE_NAME]
}

export function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  maxAgeSeconds: number,
): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    ...cookieOptions,
    maxAge: maxAgeSeconds,
  })
}

export function clearRefreshCookie(reply: FastifyReply): void {
  // The full attribute set, not just the path: `clearCookie` does NOT inherit
  // what `setCookie` used, and passing only the path emits SameSite=Lax with no
  // HttpOnly and no Secure (verified). Deletion works either way — browsers
  // match on name, domain and path — but emitting a weaker cookie is noise
  // nobody wants to explain later.
  reply.clearCookie(REFRESH_COOKIE_NAME, cookieOptions)
}

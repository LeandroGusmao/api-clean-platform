# The `auth` module

Authentication and session. It is the only module that knows what a credential
is: it handles sign-up, e-mail verification, login (by password or with Google),
session (through the refresh token), password change and recovery, session management, account deletion and logout.
Other modules only receive the `id` of the already-authenticated user — they
import nothing from here.

This document is for whoever **consumes** or **reads** `auth` and wants to
understand the flow. The structure the code follows is in
[`ARCHITECTURE.md`](../../../ARCHITECTURE.md).

---

## Endpoints

All under the `/auth` prefix.

| Endpoint | What it does | Needs a token? |
|---|---|---|
| `POST /register` | Starts the sign-up of an e-mail and sends a code | no |
| `POST /email/verify/resend` | Resends the verification code | no |
| `POST /email/verify` | Confirms the e-mail with the code + the chosen password; **creates the account** and opens the session | no |
| `POST /login` | Authenticates by e-mail and password; opens the session | no |
| `POST /google` | Exchanges a Google ID token for a session; creates or links the account | no |
| `POST /refresh` | Rotates the refresh token (renews the session) | refresh token |
| `POST /logout` | Ends this session | refresh token |
| `POST /logout-all` | Ends **all** the account's sessions | access token |
| `POST /password` | Changes the password; ends the other sessions | access token |
| `POST /password/forgot` | Starts password recovery; sends a token by e-mail | no |
| `POST /password/reset` | Resets the password with the token; ends **all** sessions | no |
| `GET /me` | Profile of the authenticated user | access token |
| `DELETE /me` | Deletes the account and everything tied to it, for good | access token |
| `GET /sessions` | Lists the account's active sessions | access token |

A protected route = send the access token in the `Authorization: Bearer <token>`
header. Without it, or with it invalid/expired, the response is `401`.

---

## Flows

### Sign-up — the account is born at step 3

1. **`POST /auth/register`** — body `{ email }`. **Always** answers **`202`**,
   with no body. A 6-digit code is sent to the address. **No account is created
   yet** — only a pending registration, which expires in 15 minutes.

   The response is identical for a free address, an address with a sign-up in
   progress and an address that already has an account. What changes is **the
   e-mail the address receives** (a code, or a notice "someone tried to create an
   account with your address"). That is deliberate: nobody finds out through this
   endpoint whether an e-mail has an account.

   Repeating the sign-up does not repeat the e-mail: each address receives **at
   most one e-mail per minute** (`EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`)
   through this endpoint, whether it is the code or the notice. For an existing
   account, the mark of the last notice is kept in `account_exists_notices`,
   written by a conditional upsert in Postgres — it holds across replicas and
   under concurrent requests. The interval is the same in both cases on purpose:
   with different intervals, the response time of a repeat would reveal whether
   the address has an account.

2. **`POST /auth/email/verify/resend`** *(optional)* — body `{ email }`. Always
   answers `202`. Resends the code for a sign-up in progress, at most once per
   minute.

3. **`POST /auth/email/verify`** — body
   `{ email, code, password, refreshTransport? }`. Answers `200` with
   `{ accessToken, refreshToken? }`. **This is where the account is created**,
   already verified, with **the password sent in this request**, and the session
   is opened.

   A nonexistent, wrong or expired code, or one with attempts exhausted (5) →
   **`422 EMAIL_VERIFICATION_FAILED`**, a single error for every case.

**Why the password only comes in at step 3:** the code only reaches the inbox of
the address's owner, so whoever completes the confirmation is the one who picks
the password. That closes *account pre-hijacking* — an attacker cannot make the
victim's account be born with a password they know.

### Login

**`POST /auth/login`** — body `{ email, password, refreshTransport? }`.
Answers `200` with `{ accessToken, refreshToken? }`.

- **`401 INVALID_CREDENTIALS`** — wrong e-mail or password. It does not say
  which. A Google-only account (no password) lands here on any attempt.
- **`403 EMAIL_NOT_VERIFIED`** — right credential, e-mail not yet confirmed. In
  practice every account is born verified (step 3 of the sign-up, or the Google
  login); this gate stays as defense in depth.

### Login with Google

**`POST /auth/google`** — body `{ idToken, password?, refreshTransport? }`. The
client runs Google's SDK, obtains the **ID token** and sends it here. The API
verifies the signature against Google's public JWKS (`email_verified: true` is
required) and issues `200` with `{ accessToken, refreshToken? }` — the same
session as `login`.

- **New e-mail** → creates a **verified, password-less** account, links the Google
  identity, and opens the session.
- **Pending sign-up for the e-mail** → Google wins: the account is born verified
  and the pending registrations for that address are deleted.
- **Second sign-in from the same Google** → fast path; matches the stored identity
  and opens the session.
- **The e-mail already has an account with a password** →
  **`409 GOOGLE_LINK_REQUIRES_PASSWORD`**. Resend the same request with
  `password` (the **app's** password) to prove ownership and link Google; a wrong
  password → **`401 INVALID_CREDENTIALS`**. The link triggers a notice e-mail to
  the owner. Once linked, the account signs in with either Google or the password.
- **`401 INVALID_GOOGLE_IDENTITY`** — a token that is invalid, expired, from
  another `client_id`, from another issuer, or with a false `email_verified`. A
  single error for all of them.

### Session — two tokens

- **access token** — a short-lived JWT (1 h). Authorizes the protected routes.
  Verified by signature, without going to the database.
- **refresh token** — an opaque, long-lived value (60 days, sliding). Carries the
  session. It comes back in the response body **or** in an `HttpOnly` cookie,
  depending on `refreshTransport` (`"body"` — the default — or `"cookie"`).

**`POST /auth/refresh`** — body `{ refreshToken? }` (or the cookie). **Rotates**:
each use invalidates the presented token and returns a new pair. Presenting an
already-rotated token again (outside a 30 s grace window) is treated as **reuse**
— the whole "family" of that session is revoked and the response is `401`.

Each login opens a **family of its own**. Ending the session on one device does
not affect the others.

### Password change

**`POST /auth/password`** *(access token)* — body
`{ currentPassword, newPassword, refreshTransport? }`. Answers `200` with a new
pair. It requires the current password (`422 INVALID_CURRENT_PASSWORD` if wrong),
**ends all the other sessions** and sends an e-mail notifying the account owner.

### Password recovery

**`POST /auth/password/forgot`** — body `{ email }`. **Always** answers **`202`**,
with no body. If the address has an account, a reset token goes to its inbox. If
it does not, **nothing happens** — same response. One live token per account,
replaced on each `forgot`, with a 30-minute TTL. A new send is blocked by a
60-second cooldown: the cooldown limits how often `forgot` resends a token, not
its redemption through `reset`.

**`POST /auth/password/reset`** — body `{ token, newPassword }`. Resets the
password, **revokes all** the account's sessions and answers `204` with no body. A
nonexistent / wrong / expired / already-used token → a single, generic error
(`422 PASSWORD_RESET_FAILED`). The response carries no tokens — the client signs
in again with the newly set password.

The token is a **256-bit opaque value**, deterministic for lookup by a unique
index. A 6-digit code would not be safe in this context (account-takeover grade)
and a tight attempt ceiling buys weak protection against a distributed botnet —
256 bits close off brute force by construction.

### Logout

- **`POST /auth/logout`** — body `{ refreshToken? }` (or the cookie). Answers
  `204`. Revokes the whole family of that token.
- **`POST /auth/logout-all`** *(access token)* — answers `204`. Revokes all the
  account's families.

### Profile

**`GET /auth/me`** *(access token)* — answers `200` with
`{ id, email, emailVerifiedAt, createdAt }`. The password hash never leaves here.

### Active sessions

**`GET /auth/sessions`** *(access token)* — answers `200` with an array, one
entry per session: `{ id, createdAt, expiresAt, ip, deviceLabel, startedAt }`. A
session is a refresh-token family that still has a live, unrevoked, unexpired
row — a login opens it and it stays the same chain through every rotation. `ip`
follows the client and reflects the latest rotation, while `deviceLabel` and
`startedAt` describe the session as a whole; `ip` is `null` when the address did
not parse.

### Account deletion

**`DELETE /auth/me`** *(access token)* — body `{ password? }`. Answers `204` with
no body. Deletes the account and everything tied to it: every session, every
linked provider, every password reset token, and any pending registration for the
address. **Irreversible** — there is no grace period and nothing is exported
first.

- An account with a password must present it; a wrong one →
  **`422 INVALID_CURRENT_PASSWORD`**.
- An account that only signs in with Google has no password to present, but still
  sends a body — an empty JSON object — since a request with no body at all is
  rejected as malformed.
- The user id comes from the access token, never from the body.
- Access tokens already issued stay valid until they expire, with nothing left to
  reach. A refresh cookie sent with the request is cleared.

---

## Seed data (development)

`pnpm db:seed` creates, **in the local database only**, accounts under
`@seed.local` — running it again deletes and recreates that namespace, and nothing
outside it. Each value lives in the file of the scenario that uses it, in
`infra/seeds/`.

| Scenario | Account | How to use |
|---|---|---|
| `auth:base-users` (default) | `dev@seed.local` | login with the password `seed-Dev-2026!` |
| | `google@seed.local` | Google only, no password — password login answers `401` |
| `auth:pending-registration` | `pending@seed.local` | `POST /auth/email/verify` with the code `123456` and a valid password |

The password is kept here and in `SEED_PASSWORD` (`infra/seeds/index.ts`), never in
the seed's log.

## Error format

Every error has the same shape:

```jsonc
{
  "error": {
    "code": "INVALID_CREDENTIALS",   // SCREAMING_SNAKE_CASE, stable — this is what the client branches on
    "message": "Invalid credentials", // for log/debug, NOT to show to the user
    "details": [ { "field": "email", "code": "INVALID_FORMAT" } ], // only on a validation error
    "traceId": "01JXYZ..."
  }
}
```

`400` covers a malformed payload (including an unknown field on `register`, which
has a strict schema). `429` comes from the per-IP rate limit — each sensitive
route has its own ceiling. `503` (with `Retry-After`) only appears on routes that
open a transaction, when a database conflict survives the retries.

---

## What this module does **not** do (yet)

- **Google's redirect / BFF flow** (`/start` + `/callback`, with `state`+PKCE and
  `client_secret`) — the client-driven `POST /auth/google` already covers mobile
  and SPA; the redirect is a future slice that reuses the same linking core.
- **Unlinking a provider** from an account.
- **Setting the first password** on a Google-only account.
- **Listing the linked providers** in `GET /me`.
- **Domain restriction** (`hd` / Google Workspace).

---

## Guarantees a consumer can assume

- `register` and `resend` **always** answer `202` — accounts can never be
  enumerated through them.
- `confirm` has a **single error** (`422 EMAIL_VERIFICATION_FAILED`) for every
  code failure mode.
- `forgot` **always** answers `202` — an address with or without an account, an
  identical response.
- `reset` has a **single error** (`422 PASSWORD_RESET_FAILED`) for every token
  failure mode.
- The account only exists **after** confirmation (or the first Google login);
  before that, `login` on that e-mail answers `401` (the account does not exist).
- `POST /auth/google` only issues a session for an ID token with `email_verified:
  true`.
- The `409 GOOGLE_LINK_REQUIRES_PASSWORD` refusal is **specific on purpose** —
  Google has already proven the e-mail, so saying "this address already has an
  account" leaks nothing. It is the module's only door that opens that exception
  to anti-enumeration.
- The password hash never appears in a response or in a log.
- An error `code` is a stable contract; `message` is not.

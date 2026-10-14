# What each product decides

**None of this is a gap in the boilerplate.** These are choices that depend on
what the app does, who uses it and what the risk is — and for that reason they
have no right answer before there is a product to validate them against.

The boilerplate's backlog closed on 2026-09-20. What remains is this list, and
almost all of it is locked behind the same trigger: **which derived app comes
first.** The two candidates change the order — a financial aggregator raises MFA
and encryption at rest; a nutrition app raises the audit trail and retention.

Each entry says: what it is · why it is not here · what reopens it · what it
costs until it is done.

The structure the code follows is in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## MFA / TOTP

**What it is.** A second factor at login, typically TOTP with an authenticator
app.

**Why it is not here.** It does not appear in any project document, and that is
not an oversight: MFA forces a decision about recovery (backup codes? SMS?
e-mail?), and each answer has a different risk profile. Without a product the
choice would be arbitrary — and a badly designed MFA locks the user out of their
own account.

**Trigger.** The first derived app that handles sensitive data. It is the largest
product gap for a financial app.

**Cost in the meantime.** The password is the only factor. A credential leaked
from another service and reused here gives full access, and nothing on the server
tells that apart from a legitimate login.

---

## Authentication failure counting / lockout

**What it is.** Counting wrong passwords per account or per IP+e-mail pair, and
blocking after N.

**Why it is not here.** It is a decision **not** to do it in the app, not an
omission. The limiter counts requests, not failures — only the application knows
the password was wrong, but implementing that would require a store port, a
two-bucket policy in the pure layer, a memory ceiling with an eviction policy and
a dedicated Redis path, to reimplement worse what the edge (Cloudflare/WAF/ALB)
already does for the coarse half of the problem.

The IP + e-mail pair policy was analyzed and **discarded**: the pair alone does
not stop a distributed attack (a thousand IPs are a thousand buckets), and the
per-e-mail bucket that would stop it is a DoS vector against the victim — anyone
can lock anyone's account knowing only the address.

**What holds today.** The 10/min cap per address on login, shared across replicas
through Redis; the argon2 cost, measured at 7.3 ms and 19 MB per attempt; the
login's timing equalization, which prevents discovering *which* account exists
before attacking it; and the per-IP cap at the edge, which is where a botnet is
genuinely visible.

**Trigger.** The first derived app that handles sensitive data (health,
financial), or the first incident of an account compromised by brute force. **The
first trigger has already been raised** by the 2026-09-07 audit — treat this as
reopened, not as decided.

**Cost in the meantime, plainly.** An account with a known e-mail and a weak
password can be broken by a patient botnet — each IP spends 10/min, a thousand
IPs add up to ten thousand attempts per minute — and **nothing on the server will
notice**. Edge protection only applies to the traffic that goes through it: if
the origin IP is reachable directly, the attacker skips everything.

---

## Leaked-password check

**What it is.** Refusing, when the password is created, one that has already
appeared in a public leak — through an external API (HIBP, with k-anonymity) or
an embedded list.

**Why it is not here.** The decision between an external API and an embedded list
has not been made, and it changes the whole design: the API adds a network
dependency on a critical path and a fail-open/fail-closed decision; the embedded
list adds megabytes to the build and ages.

**Trigger.** The first real users, or the first derived app that handles
sensitive data — whichever comes first. **Deferred on purpose on 2026-09-19, not
forgotten.**

**Cost in the meantime.** The floor is 8 characters and there is no blocklist.
Since lockout was refused above, the argon2 cost and the quality of the password
are the only two defenses against brute force — and one of them is at the floor.

**Design caveat.** A notification warning, once the app has that channel, would
only cover the check at login (accounts that already exist). It does not replace
validation at password creation, which is what actually protects.

---

## RBAC / permissions

**What it is.** Who can do what. Roles, permissions, or both.

**Why it is not here.** Reclassified on 2026-09-17 from "pending architecture
decision" to product scope, by the same argument that closed the generic outbox:
without a real second consumer there is no way to validate the right shape, and
"who can do what" varies by product in a way that "how not to leak a session"
does not. A single role (`admin`/`user`) would be too simple to really serve;
roles with associated permissions would be a decision made with no product to
validate against.

**Trigger.** The first derived app that needs per-user differentiated access. The
right decision depends on what **that** product needs — a single role? per
resource? per organization? — and not on what this document would guess today.

**Trade-off to preserve for when it is picked up again.** If the role goes inside
the JWT, a permission change only takes effect on the next refresh: a window of up
to the access token's TTL. It is the same revocation latency that authentication
already accepted by keeping the database out of the authenticated path, now
applying to authorization too.

---

## Multi-tenancy

**What it is.** Isolating data by organization/customer within the same
installation.

**Why it is not here.** It decides the shape of almost every table in the system
(a `tenant_id` column? a schema per tenant? a database per tenant?), and the wrong
choice is expensive to undo. Making it without a product would be a guess with a
high cost.

**Trigger.** The first derived app whose customer is an organization rather than
a person.

**Cost in the meantime.** None immediately — `auth` is per person and works. The
cost is in the future: retrofitting multi-tenancy onto a schema that did not
foresee it touches every table and every query.

---

## Encryption at rest

**What it is.** Encrypting sensitive columns in the database (column-level,
`pgcrypto`, or application-side encryption).

**Why it is not here.** `auth` does not store sensitive data: it stores an e-mail,
a password hash (which is the opposite of reversible) and session metadata. There
was nothing to encrypt.

**Trigger.** The first module that stores truly sensitive data — a balance, a
transaction, health data.

**Cost in the meantime.** None today. But `auth` **sets the precedent**: the
module that stores the data will copy the pattern it finds, and today the pattern
is "plain text in Postgres".

---

## argon2 cost above the minimum

**What it is.** Raising the time and memory parameters of the password hash.

**Why it is not here.** The current 7.3 ms / 19 MB is the **OWASP recommended
minimum**, and tuning above it requires a target machine to measure on. The
adapter's comment already records this as "hardening, once there is a target
machine".

**Trigger.** There being a defined production machine to measure against.

**Cost in the meantime.** Each brute-force attempt costs the minimum acceptable,
not the maximum the infrastructure could bear. Together with the absence of
lockout and of a leaked-password check, it is the third leg of the same defense.

---

## Step-up / re-authentication for a high-value operation

**What it is.** Requiring the password again (or the second factor) before a
sensitive operation, based on *how long ago* and *by which method* the user
authenticated.

**Why it is not here.** The access token carries neither `auth_time` nor `amr`,
by the rule that `ports/token-signer.ts` states: a contract is born with its
consumer, and no route asks this today. Account deletion, which would be the
candidate, was solved by re-presenting the current password.

**Trigger.** The first route that needs to tell "logged in" from "logged in just
now" — a transfer of value, a change of bank details, a bulk export.

**Cost in the meantime.** Adding the claims now is cheap; later it is a token
format migration, with a coordination window if there is already a client in
production. It is the same arithmetic as `kid` below.

---

## `kid` in the JWT (signing key rotation)

**What it is.** Tagging the access token's header with the name of the key that
signed it, so the server can have one key that signs and others that only verify.

**Why it is not here.** Deferred on 2026-09-20. Verified in the code:
`POST /auth/refresh` does not go through the guard and does not read the access
token — it only consumes the opaque refresh token. Swapping `JWT_SECRET` live
**does not log anyone out**: each client takes a `401`, calls `/refresh` and
carries on, which is the same path they already walk on every expiry. What `kid`
buys is **timing**, not security: it prevents everyone from renewing at the same
instant. With no users in production, that stampede is zero requests.

**Trigger — and it comes before the need, on purpose.** Reopen **before** the
first derived app goes to production, not when the stampede shows up. `kid`
changes the token's header format, which is cheap to change while there is no
client out there and expensive afterwards.

**Cost in the meantime.** A key swap produces a spike of simultaneous refreshes.
Nothing breaks; the database works harder for a few seconds.

**The design already explored**, for whoever picks it up: keep `JWT_SECRET` as the
key that signs, with a `JWT_SECRET_KID` naming it and a verify-only variable with
the retired ones (compatible with every existing `.env`) — preferred over a single
JSON list, which breaks the environments, and over a `kid` derived by hashing the
secret, which stays opaque to the operator. There is a half-delivery: emit the
`kid` in the header now, one line and zero config, leaving multi-key verification
for later.

---

## Table name collision between modules

**What it is.** Nothing prevents two modules from declaring a `users` table.
`drizzle-kit` merges the globs and generates the migration with both — and the
error shows up in `db:migrate`, not in the lint.

**Why it is not here.** Decided to stay in `public` for now. The possible ways out
are discipline, a per-module prefix (`auth_users`) or a Postgres schema per module
(`pgSchema('auth')`), and `ALTER TABLE ... SET SCHEMA` makes a later migration
cheap — so deferring costs little.

**Trigger.** The second module with persistence of its own.

**Cost in the meantime.** A collision gets past the boundary lint and fails in the
migration, far from the cause.

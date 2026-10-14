# api-clean-platform

Node + TypeScript API boilerplate for deriving products. It ships complete
authentication and session handling, the boundary between pure code and code
that touches the outside world, and the infrastructure every app needs before it
has a single feature — already built and tested, not sketched.

**Stack:** Node 24 · TypeScript 7 (ESM) · Fastify 5 · Zod 4 · PostgreSQL ·
Drizzle · Redis · OpenAPI · Vitest · Biome · pnpm

---

## Getting started

**Prerequisites:** Node ≥ 24.19 (`.nvmrc`), pnpm ≥ 11.7, Docker.

```bash
pnpm install
cp .env.example .env     # adjust JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE
pnpm db:up               # postgres, postgres-test and mailpit
pnpm db:migrate
pnpm db:seed             # optional: test accounts in a known state
pnpm dev
```

The API comes up at `http://localhost:3000`. In development, the OpenAPI
documentation is served at `/docs`. Apart from the `auth` routes and
`GET /health`, every path answers `404` — that is expected, there is no business
module yet.

E-mails are not really sent in development: they land in Mailpit, at
`http://localhost:8025`.

---

## What ships out of the box

**Accounts and sessions.** Two-step sign-up where the account is created when the
e-mail is confirmed — not before —, login by password or with Google, and an
authenticated profile.

**Sessions with rotation and reuse detection.** A short-lived JWT access token
and an opaque, persisted refresh token that rotates on every use. Presenting an
already-spent token again revokes the whole family and notifies the owner. The
session has an absolute ceiling on top of the inactivity timeout.

**Password.** Change with the current password, e-mail recovery with a
single-use token, and argon2id at OWASP's recommended minimum. Every change or
reset drops the other sessions.

**Self-service account management.** List active sessions, end one or all of
them, delete the account with the full cascade.

**Audit trail.** Five security events written in the same transaction that
changes the state, with IP and device.

**The infrastructure underneath.** Explicit Unit of Work for atomicity ·
transactional outbox so that a crash between commit and send does not lose the
e-mail · rate limit shared across replicas through Redis · error taxonomy with a
correlated `traceId` · cron with a per-module job registry · development seed ·
OpenAPI generated from the Zod schemas · `helmet` and CORS.

The detail of each `auth` flow is in
[`src/modules/auth/README.md`](src/modules/auth/README.md).

---

## Commands

```bash
pnpm dev                 # development with watch
pnpm build               # compile to dist/
pnpm start               # run the build

pnpm lint                # biome + the §2 boundary (dependency-cruiser)
pnpm typecheck           # tsc --noEmit
pnpm test:unit           # the lane without I/O
pnpm test:integration    # the lane with a real Postgres (pnpm db:up first)

pnpm db:up               # start the containers
pnpm db:migrate          # apply pending migrations
pnpm db:generate --name=<name>   # generate a migration from the schema; ALWAYS with --name
pnpm db:seed             # known state in the local database
pnpm db:reset            # drop the schema, reapply the migrations and seed — no manual `db:migrate`
pnpm db:studio           # inspect the database
```

The full list is in [`ARCHITECTURE.md`](ARCHITECTURE.md) §10.

---

## Where to go

| If you want to | Read |
|---|---|
| Understand how the code is organized and what may import what | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Add a new module | [`ARCHITECTURE.md`](ARCHITECTURE.md) §13 |
| Know what **your product** still has to decide | [`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md) |
| Use or consume `auth` | [`src/modules/auth/README.md`](src/modules/auth/README.md) |

---

## Before deriving a product

Read [`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md). The boilerplate left
choices open **on purpose** — MFA, authentication lockout, RBAC, multi-tenancy,
leaked-password checking, encryption at rest — because the right answer depends
on what the app does and who uses it. Each one is listed there with the trigger
that reopens it and the cost of not having it.

None of them is a forgotten gap. All of them are decisions that were made, and
the document states the reasoning.

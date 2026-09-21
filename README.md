# api-clean-platform

Boilerplate de API em Node + TypeScript para derivar produtos. Traz autenticação
e sessão completas, a fronteira entre código puro e código que toca o mundo
externo, e a infraestrutura que todo app precisa antes de ter qualquer feature —
já construído e testado, não esboçado.

**Stack:** Node 24 · TypeScript 7 (ESM) · Fastify 5 · Zod 4 · PostgreSQL ·
Drizzle · Redis · OpenAPI · Vitest · Biome · pnpm

---

## Começando

**Pré-requisitos:** Node ≥ 24.19 (`.nvmrc`), pnpm ≥ 11.7, Docker.

```bash
pnpm install
cp .env.example .env     # ajuste JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE
pnpm db:up               # postgres, postgres-test e mailpit
pnpm db:migrate
pnpm db:seed             # opcional: contas de teste em estado conhecido
pnpm dev
```

A API sobe em `http://localhost:3000`. Em desenvolvimento, a documentação
OpenAPI fica em `/docs`. Fora as rotas do `auth` e `GET /health`, qualquer
caminho responde `404` — é o esperado, ainda não há módulo de negócio.

E-mails não saem de verdade em desenvolvimento: caem no Mailpit, em
`http://localhost:8025`.

---

## O que já vem pronto

**Contas e sessão.** Cadastro em duas etapas onde a conta nasce na confirmação
do e-mail — não antes —, login por senha ou com Google, e perfil autenticado.

**Sessão com rotação e detecção de reuso.** Access token curto em JWT, refresh
token opaco e persistido que rotaciona a cada uso. Reapresentar um token já
gasto revoga a família inteira e avisa o dono. A sessão tem teto absoluto além
do timeout por inatividade.

**Senha.** Troca com a senha atual, recuperação por e-mail com token de uso
único, e argon2id no mínimo recomendado pela OWASP. Toda troca ou redefinição
derruba as outras sessões.

**Gestão da própria conta.** Listar sessões ativas, encerrar uma ou todas,
deletar a conta com a cascata completa.

**Trilha de auditoria.** Cinco eventos de segurança gravados na mesma transação
que muda o estado, com IP e aparelho.

**A infraestrutura por baixo.** Unit of Work explícito para atomicidade · outbox
transacional para que um crash entre o commit e o envio não perca o e-mail ·
rate limit compartilhado entre réplicas via Redis · taxonomia de erro com
`traceId` correlacionado · cron com registry de jobs por módulo · seed de
desenvolvimento · OpenAPI gerado dos schemas Zod · `helmet` e CORS.

O detalhe de cada fluxo do `auth` está em
[`src/modules/auth/README.md`](src/modules/auth/README.md).

---

## Comandos

```bash
pnpm dev                 # desenvolvimento com watch
pnpm build               # compila para dist/
pnpm start               # roda o build

pnpm lint                # biome + a fronteira do §2 (dependency-cruiser)
pnpm typecheck           # tsc --noEmit
pnpm test:unit           # a pista sem I/O
pnpm test:integration    # a pista com Postgres real (pnpm db:up antes)

pnpm db:up               # sobe os containers
pnpm db:migrate          # aplica migrations pendentes
pnpm db:generate --name=<nome>   # gera migration do schema; SEMPRE com --name
pnpm db:seed             # estado conhecido no banco local
pnpm db:studio           # inspeciona o banco
```

A lista completa está no [`ARCHITECTURE.md`](ARCHITECTURE.md) §10.

---

## Para onde ir

| Se você quer | Leia |
|---|---|
| Entender como o código está organizado e o que pode importar o quê | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Adicionar um módulo novo | [`ARCHITECTURE.md`](ARCHITECTURE.md) §15 |
| Saber o que **seu produto** ainda precisa decidir | [`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md) |
| Usar ou consumir o `auth` | [`src/modules/auth/README.md`](src/modules/auth/README.md) |

---

## Antes de derivar um produto

Leia [`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md). O boilerplate deixou
escolhas em aberto **de propósito** — MFA, lockout de autenticação, RBAC,
multi-tenancy, checagem de senha vazada, criptografia em repouso — porque a
resposta certa depende do que o app faz e de quem o usa. Cada uma está lá com o
gatilho que a reabre e o custo de não a ter.

Nenhuma delas é lacuna esquecida. Todas são decisões tomadas, e o documento diz
qual foi o raciocínio.

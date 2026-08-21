# Drizzle + Postgres setup, com /health verificando o banco

**Status:** aprovado, pronto para plano de implementação.
**Data:** 2026-08-20

## 1. Contexto e escopo

O `ARCHITECTURE.md` e o `DECISIONS.md` já documentam como banco e Drizzle
devem se encaixar no projeto (decisões 05, 06, 07, 16, 17, 21), mas nada disso
existe em `src/` ainda — só `infra/config/env.ts` e `infra/http/` (com o
endpoint `/health` de liveness, adicionado antes desta spec) foram construídos
até aqui.

**Este trabalho entrega:**
- A infra de conexão com o Postgres (pool `pg` + instância Drizzle).
- O tooling de migration (`drizzle-kit`, `drizzle.config.ts`), pronto mas sem
  nenhuma migration real ainda.
- Docker Compose para subir o Postgres localmente (decisão 16 nunca foi
  implementada — não existe `docker-compose.yml` no repo).
- `/health` passa a reportar também o estado da conexão com o banco, não só
  que o processo está vivo.

**Não entra:**
- Qualquer módulo de negócio (`auth` ou outro) — não há dono de schema ainda,
  então não há tabela para criar.
- `dependency-cruiser` — já listado como `EM ABERTO` no `ARCHITECTURE.md` §3,
  não é o assunto desta spec.
- SSL na conexão do pool — sem alvo de deploy definido ainda; adicionar
  quando houver um.

## 2. Versão do Postgres — divergência resolvida

Os docs existentes citam `postgres:17` no exemplo de pipeline de CI
(`ARCHITECTURE.md` §15, `DECISIONS.md` decisão 17). Definido nesta spec: a
versão real a usar em todo lugar (compose local e exemplo de CI) é
**`postgres:18.4-alpine3.24`**. Os dois documentos serão atualizados para não
ficar com uma versão descrita e outra construída — regra do próprio
`ARCHITECTURE.md`: "se está escrito, está construído e verificável".

## 3. Configuração — `DATABASE_URL`

Uma única connection string, no schema core do `infra/config/env.ts` (não é
config de módulo — conexão com banco é infra global, decisão 14 só se aplica
a env var de módulo):

```ts
DATABASE_URL: z.url()
```

Sem default: variável obrigatória, falha o boot com a lista de erros se
faltar — mesmo padrão já usado para as demais vars em `env.ts`.

`.env.example` ganha uma linha batendo com as credenciais do
`docker-compose.yml`:

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/app
```

## 4. Docker Compose

Primeiro `docker-compose.yml` do repo. Só infra (decisão 16 — a aplicação
roda no host via `pnpm dev`):

```yaml
services:
  postgres:
    image: postgres:18.4-alpine3.24
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

## 5. Cliente do banco — `src/infra/database/client.ts`

Novo arquivo, infra global (mesma categoria de `infra/http/server.ts` e
`infra/config/env.ts` — sem dono de módulo):

```ts
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { Env } from '#infra/config/env'

// O que o callback de `db.transaction()` recebe não tem o mesmo tipo do
// handle de topo — repositórios que aceitam os dois precisam da união.
export type Database = NodePgDatabase<Record<string, never>> | PgTransaction<any, any, any>

export function createDatabase(env: Env): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString: env.DATABASE_URL })
  const db = drizzle(pool)
  return { db, pool }
}
```

`createDatabase` devolve o `pool` além do `db` porque `main/http.ts` precisa
dele para fechar a conexão no shutdown (`pool.end()`), e o `Database` não
expõe isso.

**Sem preflight de conexão.** `new Pool(...)` não conecta na hora — conecta
sob demanda, na primeira query. Isso é deliberado (ver §7): o processo sobe
mesmo com o banco fora do ar.

## 6. `drizzle.config.ts` (raiz do projeto)

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/*/infra/drizzle/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

O glob de `schema` não casa com nada hoje — não existe módulo. Começa a valer
no dia em que um módulo declarar `infra/drizzle/schema.ts`, sem precisar
tocar neste arquivo (decisão 06).

`drizzle-kit` lê `process.env` diretamente (fora do runtime da aplicação,
roda como CLI) — isso não viola R6, que é sobre o **código da aplicação**.

## 7. `/health` verificando o banco

O endpoint já existe (`src/infra/http/endpoints/health.ts`) e hoje só reporta
liveness. Passa a receber `db: Database` por opção do plugin — mesmo
mecanismo usado para os módulos injetarem o container (§7 do
`ARCHITECTURE.md`), adaptado pra infra global sem container:

```ts
export const healthRoute: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    HEALTH_CHECK_PATH,
    { schema: { response: { 200: okSchema, 503: downSchema } } },
    async (_req, reply) => {
      try {
        await db.execute(sql`select 1`)
        return { status: 'ok' as const, database: 'up' as const }
      } catch {
        return reply.status(503).send({ status: 'error' as const, database: 'down' as const })
      }
    },
  )
}
```

- Sucesso → `200 { status: "ok", database: "up" }`.
- Falha → `503 { status: "error", database: "down" }`. Torna `/health`
  utilizável por load balancer / orquestrador para tirar a instância de
  circulação automaticamente.
- Usa `db.execute` (API core do Drizzle) — não `db.query.*`, coerente com R1
  mesmo essa regra sendo escrita pensando em repositórios.

`main/http.ts` monta `{ db }` no boot e registra:

```ts
const { db, pool } = createDatabase(env)
await app.register(healthRoute, { db })

// no shutdown, junto do app.close():
await pool.end()
```

## 8. Dependências (`package.json`)

Todas pinadas em versão exata (decisão do projeto: nenhuma dependência com
`^` ou `~`):

| Pacote | Versão | Onde |
|---|---|---|
| `drizzle-orm` | `1.0.0-rc.4` | `dependencies` |
| `pg` | `8.23.0` | `dependencies` |
| `drizzle-kit` | `1.0.0-rc.4` | `devDependencies` |
| `@types/pg` | `8.23.1` | `devDependencies` |

Novos scripts:

```jsonc
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate"
```

(Correspondem ao passo `drizzle-kit migrate` já citado no exemplo de pipeline
do `ARCHITECTURE.md` §15/§6.)

## 9. Atualização dos docs

`ARCHITECTURE.md` e `DECISIONS.md`:
- Troca `postgres:17` → `postgres:18.4-alpine3.24` no exemplo de pipeline de
  CI (mantendo dev e CI na mesma versão, conforme o racional já escrito na
  decisão 17).
- `ARCHITECTURE.md` §9 ("o que ainda não existe"): remove "banco" da lista —
  a conexão existe. Mantém "migrations" e "módulos e camada pura", que
  continuam não existindo (nenhuma tabela real ainda).
- Stack declarada no topo do `ARCHITECTURE.md` ganha `PostgreSQL · Drizzle`.

## 10. Testes

Sem test runner configurado no projeto ainda (decisão já tomada na conversa
anterior, ao implementar o `/health` original: fora de escopo instalar
Vitest agora). Verificação desta spec é manual: subir o compose, rodar
`pnpm dev`, checar `/health` com o banco no ar e com o banco derrubado
(`docker compose stop postgres`).

## 11. Ordem de implementação sugerida

1. Dependências (`pg`, `drizzle-orm`, `drizzle-kit`, `@types/pg`).
2. `docker-compose.yml` + `.env.example`.
3. `env.ts` — `DATABASE_URL`.
4. `infra/database/client.ts` + `drizzle.config.ts`.
5. `health.ts` (query de verificação) + `main/http.ts` (wiring + shutdown).
6. Scripts `db:generate`/`db:migrate`.
7. Atualização de `ARCHITECTURE.md`/`DECISIONS.md`.
8. Verificação manual (banco no ar / banco derrubado).

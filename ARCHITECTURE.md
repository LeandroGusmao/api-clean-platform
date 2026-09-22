# Arquitetura

Como o código deste repositório está organizado e as regras que valem para
todo arquivo novo. Tudo aqui está construído; nada é plano.

O porquê de cada peça mora no comentário do código que ela governa. Este
documento dá o mapa e as regras; o detalhe de cada fluxo do `auth` está em
[`src/modules/auth/README.md`](src/modules/auth/README.md), e o que cada produto
derivado ainda precisa decidir está em
[`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md).

**Stack:** Node 24 LTS · TypeScript 7 ESM · Fastify 5 · Zod 4 · PostgreSQL ·
Drizzle · Redis · OpenAPI · Vitest · Biome · pnpm

---

## Índice

1. [O princípio](#1-o-principio)
2. [A árvore e a fronteira](#2-a-arvore-e-a-fronteira)
3. [Imports](#3-imports)
4. [Regras verificadas por máquina](#4-regras-verificadas-por-maquina)
5. [Configuração e log](#5-configuracao-e-log)
6. [Banco de dados](#6-banco-de-dados)
7. [HTTP e documentação da API](#7-http-e-documentacao-da-api)
8. [Erros](#8-erros)
9. [Testes](#9-testes)
10. [Comandos](#10-comandos)
11. [Versões](#11-versoes)
12. [Fluxo de uma requisição](#12-fluxo-de-uma-requisicao)
13. [Como adicionar um módulo novo](#13-como-adicionar-um-modulo-novo)
14. [O que ainda não existe](#14-o-que-ainda-nao-existe)

---

## 1. O princípio

> **Código puro nunca depende de código que toca o mundo externo.**

"Mundo externo" é banco, HTTP, rede, arquivo, variável de ambiente, relógio e
aleatoriedade. Tudo isso entra por contrato (uma interface na camada pura) e é
implementado em `infra/`. É isso que deixa entidade, value object e use case
testáveis em milissegundos, sem banco — e é o princípio que decide onde cada
arquivo novo cai.

---

## 2. A árvore e a fronteira

```text
src/
├── shared/                  # PURO e transversal — não conhece módulo nenhum
│   ├── errors/              # taxonomia de erro (§8)
│   └── ports/               # contratos transversais: IClock, IIdGenerator, IUnitOfWork
├── infra/                   # infra GLOBAL, sem dono de módulo
│   ├── config/env.ts        # ÚNICO lugar que lê process.env
│   ├── database/            # pool, transação, unit of work, conversão de erro do driver
│   ├── redis/               # cliente Redis
│   ├── health/checks/       # um arquivo por dependência checada pelo /health
│   ├── http/                # instância Fastify (sem rotas), guard, rate limit, CORS, OpenAPI
│   │   └── errors/          # ÚNICO lugar que traduz erro em status HTTP
│   ├── observability/       # logger, redação, traceId
│   └── providers/           # adapters dos contratos de shared/ports/
├── modules/
│   └── <modulo>/            # hoje só `auth`
│       ├── entities/  value-objects/  services/  use-cases/  errors/  notifications/
│       ├── repositories/  ports/        # SÓ contratos
│       ├── config.ts                    # schema Zod das env vars do módulo
│       ├── container.ts                 # monta o grafo concreto do módulo
│       └── infra/                       # tudo do módulo que toca o mundo externo
│           ├── drizzle/                 # schema/ (um arquivo por tabela), mappers, repositórios
│           ├── in-memory/               # dublês de repositório para teste
│           ├── providers/               # adapters dos contratos de ports/
│           ├── seeds/                   # cenários de `pnpm db:seed`
│           └── http/                    # endpoints/ (1 arquivo = schema + handler + rota), routes.ts
└── main/                    # composition root: o único que conhece todos os módulos
    ├── container.ts         # junta os containers dos módulos
    ├── app.ts               # compõe a aplicação HTTP, SEM escutar
    ├── http.ts  cron.ts     # entrypoints
    ├── seeds/               # entrypoint de `pnpm db:seed`
    └── reset/               # entrypoint de `pnpm db:reset`: dropa, migra, semeia

tests/integration/           # suítes contra Postgres e Redis reais
tools/boundaries/            # o lint de fronteira e suas fixtures
drizzle/                     # migrations geradas e commitadas
```

Se você não consegue dizer de qual módulo uma peça é, ela é global
(`src/infra/` ou `src/shared/`).

### A regra de fronteira

O §1 aplicado por caminho de arquivo. É esta tabela que o lint configura
(`tools/boundaries/layers.mjs`).

| Elemento | Padrão | Pode importar |
|---|---|---|
| `pure` | `src/modules/*/{entities,value-objects,repositories,ports,use-cases,services,dtos,errors,notifications}/**` · `src/modules/*/config.ts` · `src/shared/**` | só `pure` |
| `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · o `module-infra` **do próprio módulo** |
| `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| `composition` | `src/modules/*/container.ts` · `src/main/**` | tudo |
| `test` | `**/*.spec.ts` · `tests/**` · `**/fixtures/**` · `**/in-memory/**` | tudo |

- **`composition` e `test` são exceções deliberadas.** O composition root existe
  para conhecer o concreto; o teste precisa alcançar o dublê in-memory.
- **`fixtures/` e `in-memory/` são `test` pelo nome da pasta**, mesmo vivendo
  sob `src/`. São dublês — e ficam fora do build pelo mesmo motivo.
- **A ordem da tabela é a precedência:** o arquivo cai no primeiro elemento que
  casar, testando `test`, `composition`, `module-infra`, `pure` e `global-infra`
  nessa ordem — um `.spec.ts` dentro de `use-cases/` é `test`, não `pure`.
- **Todo arquivo de `src/` cai em algum elemento.** Pasta nova que nenhuma linha
  classifica falha o lint; adicione a linha antes de criar a pasta.

**Quem pode importar um `container.ts`:**

| Quem | O quê | Como |
|---|---|---|
| `src/main/**` | o `container.ts` de qualquer módulo | valor |
| `src/modules/<m>/infra/**` | o `container.ts` **do próprio módulo** | **só `import type`** |
| qualquer outro | — | proibido |

### Módulo não importa módulo

Nenhum elemento de um módulo alcança outro módulo — nem o `infra/`, nem a camada
pura. A regra proíbe o **import**, não a chamada: como entre microsserviços, o
consumidor segura um contrato que ele mesmo define. Três formas de cruzar, em
ordem de acoplamento:

1. **Porta de repositório no consumidor** *(a mais comum)* — o módulo chamador
   declara na sua camada pura a porta estreita de leitura que precisa; o
   adaptador em `src/main/` delega ao repositório do módulo alvo.
2. **Porta de use case no consumidor** — quando o cruzamento tem efeito
   colateral ou regra do outro módulo (reservar estoque, aplicar cupom), a porta
   descreve a operação e o adaptador executa o use case do alvo.
3. **Evento de domínio** — pelo outbox transacional, para desacoplamento
   completo.

Nos três casos a porta é do **consumidor**, e o contrato se escreve em tipos
planos (`string`, `Date`) — nunca nos value objects do outro módulo.

**Proibido:** chamada HTTP interna ao próprio servidor, reusar o handler HTTP de
outro módulo, e importar o `infra/` de outro módulo.

### O que mora em cada pasta pura

- **`use-cases/`** — orquestra um caso de uso. O DTO de entrada e saída mora no
  próprio arquivo do use case; `dtos/` só nasce quando um DTO for compartilhado.
- **`services/`** — operação de domínio que precisa de colaboradores e não
  pertence a uma entidade só (ex.: `RefreshTokenIssuer`, usado pelo login e pela
  rotação). Um `services/` que começa a receber repositório virou use case.
- **`repositories/` e `ports/`** — só interfaces. Um contrato nasce com os
  métodos e campos que têm consumidor, nada mais.
- **Comando devolve recibo, consulta devolve read model.** Use case que muda
  estado devolve o mínimo (`{ id }`); consulta devolve um objeto plano, value
  objects desembrulhados e datas ainda como `Date`.

### Unit of Work: duas regras que o lint não alcança

- **Dentro do callback do `uow`, toda escrita vem do `repos` que ele recebe.** O
  repositório injetado direto escreve em autocommit e quebraria a atomicidade só
  em produção. Leitura direta é permitida, e o repositório direto é declarado
  por `Pick` com só os métodos que o use case chama.
- **Três coisas não entram no callback,** porque a transação fica aberta a
  duração inteira dele: I/O externo (persiste dentro, envia depois do commit),
  CPU pesada (argon2 — calcula antes) e escrita que precisa sobreviver a uma
  falha (ex.: contador de tentativas).

### Composição: cada módulo tem seu container, `main/` junta

Injeção de dependência é **container manual tipado** — sem biblioteca, sem
decorator.

```ts
// modules/auth/container.ts — o módulo conhece o próprio concreto
export function makeAuthContainer(db: Database, config: AuthContainerConfig, /* ... */) {
  const usersRepository = new DrizzleUsersRepository(db)
  // ...
  return {
    registerUser: new RegisterUserUseCase(usersRepository, hashProvider, clock, idGenerator),
    getUserProfile: new GetUserProfileUseCase(usersRepository),
  }
}
export type AuthContainer = ReturnType<typeof makeAuthContainer>

// main/container.ts — o composition root junta os módulos
export function makeContainer(db: Database, env: Env, logger: AppLogger) {
  return { auth: makeAuthContainer(db, env /* ... */) }
}
```

- **Cada módulo recebe só a fatia de config que declara**, e o
  plugin HTTP do módulo recebe só a fatia dele do container. Alcançar o use case
  de outro módulo é erro de compilação.
- **O grafo é montado sem Fastify**, para servir `http.ts`, `cron.ts` e um
  futuro worker igualmente.
- **Objeto stateless é singleton** no container.

Três cortes de responsabilidade:

| Arquivo | Faz | Não faz |
|---|---|---|
| `infra/http/server.ts` | cria e configura a instância Fastify, error handler e traceId | registrar rotas |
| `main/app.ts` | monta banco, Redis, container, docs e rotas; fecha tudo no `onClose` | abrir porta |
| `main/http.ts` | `listen` e sinais de shutdown | montar grafo |

Assim o teste monta exatamente a aplicação de produção sem abrir porta, e
`app.close()` é o único teardown.

---

## 3. Imports

Não há path alias: o projeto usa **subpath imports do Node**, declarados no
`imports` do `package.json` e resolvidos pelo próprio runtime.

```jsonc
"#modules/*": { "development": "./src/modules/*.ts", "default": "./dist/modules/*.js" }
// idem para #shared/*, #infra/* e #main/*
```

**Regras:**

- **Entre diretórios de topo:** `#infra/...`, `#modules/...`, `#shared/...`,
  `#main/...`.
- **Dentro do mesmo galho** (mesma pasta ou subpasta): relativo **com extensão
  `.js`** — `./schema/users.js`. ESM `nodenext` exige a extensão.
- **Nunca subir com `..`**: `#modules/auth/errors/x`, não `../errors/x`.
- **Exceção:** `vitest.config.ts` importa `./tests/...` por caminho relativo —
  arquivo de config do Vite não passa pelo resolver do Node.

> ⚠️ **Sem `--conditions=development` e com `dist/` presente, o processo roda
> código compilado velho enquanto você edita `src/`**, sem aviso. O script `dev`
> já carrega a flag.

No `tsconfig`, `customConditions: ["development"]` (senão todo import `#` dá
`TS2307`) e, só no `tsconfig.build.json`, `rootDir: "src"` / `outDir: "dist"`
(senão a saída vira `dist/src/...` e o `imports` aponta para o nada).

---

## 4. Regras verificadas por máquina

Regra que nenhuma máquina verifica não sobrevive a N projetos derivados. Estas
falham o `pnpm lint`:

| Regra | Mecanismo |
|---|---|
| **R6** — só `src/infra/config/env.ts` lê `process.env` | Biome `style/noProcessEnv` |
| **Fronteira** — a tabela do §2 | `dependency-cruiser` + `tools/boundaries/check.mjs` |

Estas ainda dependem de revisão:

| Regra | Situação |
|---|---|
| **R7** — camada pura não produz valor não determinístico (`new Date()`, `Math.random()`, `randomUUID()`); tempo e id entram por `IClock` e `IIdGenerator` | revisão humana — é a próxima que merece dente |
| **R1** — repositório usa só a API core do Drizzle, nunca `db.query.*` | revisão humana |
| **R2** — toda coluna nomeada explicitamente | coberto na prática pelo teste de schema |
| **R4** — migrations forward-only | convenção + revisão |

A skill `architecture-audit` (`audit-scan.mjs`) é a rede de revisão: aponta por
linha o que a tabela permite mas merece olhar. O `dependency-cruiser` é o portão.

### Não desligue a fronteira sem perceber

O `dependency-cruiser` enforça **zero com exit 0** se qualquer destas três sair
de `.dependency-cruiser.mjs` / `pnpm-workspace.yaml`:

1. **`tsPreCompilationDeps: true`** — sem ele, `import type` é invisível, e
   quase toda dependência entre camadas é uma interface.
2. **`conditionNames` com `development`** — sem ele, `#` resolve para `dist/` e
   as regras param de casar.
3. **TypeScript `<7` aninhado** — o `dependency-cruiser` não fala TS 7; o
   `packageExtensions` do `pnpm-workspace.yaml` lhe dá um TypeScript 6 próprio.

O `check.mjs` guarda as três: confere a versão de TypeScript resolvida, compara
os módulos cruzados com os `.ts` em disco e falha em arquivo sem elemento.
Mudou uma regra? Atualize as fixtures em `tools/boundaries/fixtures/` — cada
negativa afirma **qual** regra disparou.

### Legal / não legal

| ✅ | ❌ |
|---|---|
| Config chega injetada: `buildServer(env)` | `process.env.X` fora de `env.ts` |
| Env numérica com `.int().positive()` | `z.coerce.number()` cru — `PORT=` vira `0` em silêncio |
| Registrar rotas em `main/app.ts` | Registrar rotas em `server.ts` |
| `import '#infra/http/server'` | `import '../../infra/http/server.js'` |
| Logar campo escolhido | Logar objeto de request, entidade ou erro de driver inteiro |
| Porta no consumidor + adaptador em `main/` | Um módulo importando outro |
| Dependência em versão exata | `^` ou `~` |

---

## 5. Configuração e log

- **`env.ts` valida tudo no boot e mata o processo** com a lista de campos
  inválidos. Env inválida não vira bug três horas depois.
- **Cada módulo declara o schema Zod das suas env vars** em `config.ts`, e o
  schema é registrado no merge de `env.ts`. Como só `env.ts` lê `process.env`
  (R6), esquecer o registro é erro de compilação, não `undefined` em produção.
- **Env numérica em branco falha no boot** em vez de virar `0` pela coerção.

**Log.** Um único pino, criado por `createLogger` em
`infra/observability/logger.ts` e compartilhado por todo entrypoint e pelo
Fastify. Regras:

- **Nunca logue objeto inteiro** — request, entidade ou erro cru. O `redact`
  cobre senha, token e headers de autenticação, mas é rede de segurança, não
  garantia: não é recursivo.
- **Todo log de request carrega `traceId`** — um UUID por request, o mesmo que
  volta no corpo de erro (§8). Ele vive num `AsyncLocalStorage`
  (`request-context.ts`), então nada precisa repassá-lo por parâmetro.
- Em development o log sai por `pino-pretty`; em produção, JSON.

---

## 6. Banco de dados

**PostgreSQL** via `pg` e Drizzle. A conexão mora em
`src/infra/database/client.ts`, compartilhada por todos os módulos.

### Pool

```text
instâncias × DATABASE_POOL_MAX  ≤  max_connections − reserva
```

Subir o pool é a alavanca errada com várias réplicas: o custo multiplica, e
cada conexão é um processo no Postgres. Passado o teto, a saída é um **pooler em
transaction mode** (PgBouncer, RDS Proxy) na frente.

- **Não use `.prepare()`.** O Drizzle manda prepared statements anônimos, que
  sobrevivem ao pooler; um statement nomeado quebra essa compatibilidade longe
  da causa.
- Pool e timeouts vêm de `DATABASE_POOL_MAX` e `DATABASE_*_TIMEOUT_MS`, com
  default em `env.ts`. **`0` num timeout não desliga** — deixa valer o do
  servidor.

### Migrations

```bash
pnpm db:generate --name=create_users_table   # SEMPRE com --name
```

- **Forward-only (R4).** Migration commitada é imutável; corrija com uma nova.
- **Nunca renomeie uma migration aplicada.** O migrator compara pelo **nome da
  pasta**: renomear a faz rodar de novo.
- `drizzle/` fica fora do Biome — é saída de ferramenta.

### Regras dos repositórios

- **Erro de driver não sai do `infra/`.** Um repositório nunca relança o erro do
  driver: a `message` do `DrizzleQueryError` carrega todo parâmetro vinculado,
  inclusive hash de senha. Converta com `toPersistenceError`
  (`infra/database/driver-error.ts`), que copia só uma lista de permissão de
  campos e não guarda `cause`.

  ```ts
  } catch (error) {
    if (isEmailAlreadyInUse(error)) throw new EmailAlreadyInUseError()
    throw toPersistenceError(error)   // nunca `throw error`
  }
  ```

- **Violação de unicidade casa o nome da constraint**, não só o código `23505` —
  senão uma colisão de primary key vira erro de domínio. O nome do índice é
  constante exportada do arquivo de schema.
- **Tempo é sempre `timestamptz`**, nunca `timestamp` sem fuso. O `Date` do JS
  trunca microssegundos para milissegundos na leitura — cuidado com comparação
  exata entre um valor do banco e um do `IClock`.
- **`updated_at` é enviado sempre, explicitamente.** Omitir a coluna deixa o
  `$onUpdate` usar o relógio do sistema em vez do `IClock`.

### Posse de tabela

Cada módulo declara as próprias tabelas em `infra/drizzle/schema/`, **um arquivo
por tabela, nomeado pela tabela**. Foreign key só entre tabelas **do mesmo
módulo**; entre módulos, referencia-se por id sem constraint. Tudo vive no
schema `public`.

### Local

`pnpm db:up` sobe via `docker-compose.yml` o Postgres de dev (5432, volume
persistente), o de teste (5433, `tmpfs`), o Redis e o Mailpit. A aplicação roda
no host. A suíte de integração aplica as migrations commitadas sozinha, no
`globalSetup`.

---

## 7. HTTP e documentação da API

- **Um endpoint é um arquivo**: schemas Zod, handler e rota juntos, em
  `infra/http/endpoints/`. Os schemas validam **e** geram o OpenAPI.
- **O handler é um tradutor.** Valida, chama o use case, escolhe o status. Um
  `if` de regra de negócio nele está no lugar errado, e ele não tem `try/catch`.
- **`/docs` e `/docs/json` só existem em `NODE_ENV=development`.** Fora dele
  respondem 404. `registerOpenApi` roda antes das rotas, senão elas somem da spec.
- Endpoint protegido referencia `security: [{ bearerAuth: [] }]`, declarado uma
  vez em `openapi.ts`.

### Todo endpoint declara todo status que ele mesmo produz

```ts
response: {
  [CREATED_STATUS]: createdSchema,
  [BAD_REQUEST_STATUS]: errorResponseSchema,   // validação do Zod
  [CONFLICT_STATUS]: errorResponseSchema,      // EmailAlreadyInUseError
},
```

O OpenAPI é o contrato de onde o cliente gera código. Declara-se o que o handler
e o schema daquela rota podem gerar — inclusive `503` em rota que abre transação.
**Não** se declara o que o framework produz em qualquer rota (`500`, `415`).

- Status não declarado no schema é **erro de compilação** no handler.
- O schema de resposta **valida** o corpo: forma que não bate vira `500`.
- `204` é `z.null()` no schema e `.send(null)` no handler.

### Data em resposta: `z.date()`, não `z.iso.datetime()`

O handler entrega o `Date` e o serializer emite ISO. Assim o use case devolve a
forma que o contrato publica, sem `.toISOString()` no handler. Formatar é
trabalho do transporte, não da camada pura.

### Health

`GET /health` agrega os checks de `infra/health/checks/`, um arquivo por
dependência. Só o banco decide o status (`200` / `503`); o Redis é reportado sem
derrubar a sonda. O processo sobe mesmo com o banco fora, para que o `/health`
consiga reportar a falha.

A checagem do banco tem prazo **no cliente**
(`DATABASE_HEALTH_CHECK_TIMEOUT_MS`): os timeouts do pool são aplicados pelo
servidor, e um servidor que parou de responder não aplica nenhum. Consulta que
estoura o prazo descarta a conexão em vez de devolvê-la ao pool.

---

## 8. Erros

Toda falha responde no **mesmo envelope**:

```jsonc
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found", "traceId": "6eedbea3-…" } }
```

**`code` é contrato** — estável, serve de chave de i18n. **`message` não é** —
serve para log e nunca deve ser exibida crua ao usuário.

### A taxonomia

`src/shared/errors/app-error.ts` é puro e não menciona HTTP: sete categorias
irmãs, todas estendendo `AppError` direto. Cada erro de domínio estende uma
delas e **declara** seu `code` (nunca derivado do nome da classe).

`infra/http/errors/error-handler.ts` é o **único** lugar que traduz erro em
status. O use case só faz `throw`.

| categoria | status |
|---|---|
| `ValidationError` | 400 |
| `UnauthorizedError` | 401 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `BusinessRuleError` | 422 |
| `TransientError` | 503 + `Retry-After` |

Um erro com `securityEvent = true` (ex.: `RefreshTokenReusedError`) responde
igual, mas também gera um `warn` no log.

### O que não vem da taxonomia

| origem | resposta |
|---|---|
| validação do Fastify/Zod | 400 `VALIDATION_ERROR` + `details[]` por campo |
| 4xx do próprio Fastify (413, 415…) | status preservado, `code` `BAD_REQUEST` |
| rota inexistente | 404 `ROUTE_NOT_FOUND` |
| rate limit | 429 `TOO_MANY_REQUESTS` + `Retry-After` do limitador |
| qualquer outra coisa | 500 `INTERNAL_SERVER_ERROR`, corpo genérico, detalhe só no log |

O `code` de cada item de `details[]` é o código do issue do Zod em maiúsculo
(`TOO_SMALL`, `INVALID_FORMAT`…); os que só revelam como o schema foi composto
colapsam em `INVALID_VALUE`.

Error handler, not-found handler e o hook do `traceId` são registrados em
`buildServer`, então todo servidor montado num teste já herda o contrato.

---

## 9. Testes

**Vitest**, separado por *project*:

| project | onde | precisa de banco | comando |
|---|---|---|---|
| `unit` | `src/**/*.spec.ts`, ao lado do código | não | `pnpm test:unit` |
| `integration` | `tests/integration/**/*.spec.ts` | sim | `pnpm test:integration` |

- **Use case se testa contra o repositório in-memory**, sem infra real.
- **Nenhum teste lê `process.env`.** A env da suíte vem de `test.env` no
  `vitest.config.ts`, e R6 vale sem exceção.
- **A integração roda um arquivo por vez** e compartilha o mesmo Postgres. Cada
  spec limpa as próprias tabelas no **`beforeEach`** — nunca assuma banco vazio.
- **Mundo externo entra por injeção também no teste**: `parseEnv(source)` separa
  a validação do `process.exit`, e `buildServer(env, { logStream })` recebe o
  destino do log.

---

## 10. Comandos

```bash
pnpm dev               # watch, resolve # para src/
pnpm build             # tsc -> dist/ (sem os specs)
pnpm start             # node dist/main/http.js
pnpm typecheck         # tsc --noEmit — a autoridade, acima do editor
pnpm lint              # biome + fronteira (§4)
pnpm lint:fix          # biome check --write
pnpm test              # unit + integração
pnpm test:unit         # sem I/O
pnpm test:integration  # Postgres e Redis reais (pnpm db:up antes)
pnpm test:watch
pnpm db:up             # sobe postgres, postgres-test, redis e mailpit
pnpm db:down           # derruba; o volume de dev sobrevive
pnpm db:logs           # logs do postgres de dev
pnpm db:generate --name=<nome>   # gera migration — SEMPRE com --name
pnpm db:migrate        # aplica migrations pendentes
pnpm db:studio         # drizzle-kit studio
pnpm db:seed           # estado conhecido no banco LOCAL (--list, --all, auth, auth:<cenário>)
pnpm db:reset          # dropa o schema, reaplica TODAS as migrations e roda o seed padrão
```

---

## 11. Versões

- **Toda dependência em versão exata. Nenhum `^`, nenhum `~`.** Dois apps
  gerados do mesmo commit têm que resolver a mesma árvore. `savePrefix: ''` faz
  todo `pnpm add` gravar exato; atualizar é um commit deliberado que passa pela
  suíte.
- **Node** é garantido por `engines` + `engineStrict: true` (o `pnpm install`
  recusa versão errada); `.nvmrc` é conveniência. `@types/node` acompanha o
  major do Node em uso, não o `latest` do npm.
- **TypeScript 7** na raiz; o `dependency-cruiser` ganha um TypeScript 6 próprio
  pelo `packageExtensions` do `pnpm-workspace.yaml` (§4). Se o editor discordar
  do `pnpm typecheck`, o editor está errado.
- **Biome** no lugar de ESLint + Prettier.
- `pnpm-workspace.yaml` guarda as settings do pnpm; sem `packages:`, este
  continua sendo um pacote único, não um monorepo.
- **Sem release estável do boilerplate enquanto o Drizzle não tiver GA** — ele
  está pinado num release candidate. R1, R2 e R4 reduzem o que uma mudança do
  Drizzle pode quebrar.

---

## 12. Fluxo de uma requisição

`POST /auth/login`, arquivo por arquivo:

```text
1. main/http.ts → main/app.ts
   Valida o env, abre banco e Redis, monta o container e registra cada
   módulo com seu prefixo e SUA FATIA do container.

2. modules/auth/infra/http/routes.ts
   Agrega os endpoints do módulo.

3. modules/auth/infra/http/endpoints/login.ts
   Valida o corpo pelo schema Zod, chama o use case, traduz o retorno em
   resposta HTTP. Sem regra de negócio.

4. modules/auth/use-cases/login-user.ts
   Busca o usuário, compara o hash (SEMPRE — contra um dummyHash quando a
   conta não existe, para o tempo de resposta não revelar quais e-mails
   existem), assina o access token e emite o refresh dentro de uow.run.
   Não conhece HTTP nem Drizzle, não loga, não chama new Date().

5. modules/auth/infra/drizzle/drizzle-users-repository.ts
   Executa o SQL e converte a row em entidade.

   Se 3, 4 ou 5 lançarem:
6. infra/http/errors/error-handler.ts
   Mapeia para status e monta o envelope com o traceId.
```

---

## 13. Como adicionar um módulo novo

**Antes, leia [`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md)** — um módulo
que guarde dado sensível reabre decisões que o `auth` deixou em aberto.

A ordem força o domínio a ser desenhado antes da infraestrutura:

1. `mkdir src/modules/<modulo>` com a anatomia do §2 — só as pastas que vai usar.
2. **Domínio:** entidades e value objects, sem pensar em banco nem HTTP.
3. **Contratos:** `repositories/` e `ports/` com o que o domínio precisa do
   mundo externo.
4. **Use cases por TDD**, contra o repositório in-memory.
5. **Infra:** schema Drizzle, mapper, repositório concreto,
   `pnpm db:generate --name=...`. Os testes de use case não mudam.
6. **HTTP:** `infra/http/endpoints/` e `routes.ts`.
7. **`config.ts`**, se houver env vars próprias, registrado no merge de
   `infra/config/env.ts`.
8. **`container.ts`**, e registre a fatia em `main/container.ts` e as rotas em
   `main/app.ts`.
9. **`pnpm lint`** — a fronteira é verificada; se o módulo precisa de outro,
   use uma porta no consumidor (§2).

---

## 14. O que ainda não existe

- **Um segundo módulo.** O `auth` é o único; as regras de comunicação entre
  módulos (§2) ainda não foram exercitadas por um caso real.
- **Entrypoint `worker.ts`.** O `cron.ts` existe; um worker de fila, não.
- **Dente em R7** (§4).

O que é escolha de produto — MFA, lockout, RBAC, multi-tenancy, `kid` no JWT,
criptografia em repouso — está em
[`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md).

# Arquitetura

Documentação do que **existe neste repositório**. Nada aqui é plano ou intenção —
se está escrito, está construído e verificável rodando os comandos da §10.

Este é o único documento de arquitetura versionado. O material de referência em
`docs/` é rascunho local, fora do git — nada depende dele.

**Stack hoje:** Node 24 LTS (Krypton) · TypeScript 7 ESM · Fastify 5 · Zod 4 · PostgreSQL · Drizzle · OpenAPI · Vitest · Biome · pnpm

---

## 1. O princípio

> **Código puro nunca depende de código que toca o mundo externo.**

"Mundo externo" é banco, HTTP, rede, arquivo, variável de ambiente, relógio e
aleatoriedade. Tudo isso entra por contrato e é implementado em `infra/`.

O primeiro código puro do repositório é a taxonomia de erro em `src/shared/`
(§8) — nenhum import, nenhuma menção a protocolo. O resto ainda é `infra/` e
`main/`. O princípio está aqui porque é ele que decide onde cada arquivo novo
vai cair.

---

## 2. A árvore

```text
src/
├── infra/                          # infra GLOBAL, sem dono de módulo
│   ├── config/
│   │   ├── env.ts                  # ÚNICO lugar que lê process.env
│   │   └── env.spec.ts             # unitário colocado
│   ├── database/client.ts          # pool pg + instância Drizzle
│   ├── health/
│   │   └── checks/
│   │       └── database-check.ts   # um arquivo por dependência checada
│   ├── http/
│   │   ├── server.ts               # instância Fastify, SEM rotas
│   │   ├── server.spec.ts          # unitário colocado
│   │   ├── error-handler.ts        # ÚNICO lugar que traduz erro em status HTTP
│   │   ├── error-handler.spec.ts
│   │   ├── error-response.ts       # schema Zod do envelope de erro
│   │   ├── validation-issues.ts    # tradução Zod -> códigos do contrato
│   │   ├── openapi.ts              # OpenAPI + UI dos docs (só em development)
│   │   └── endpoints/
│   │       └── health.ts           # GET /health — agrega os checks
│   └── observability/
│       ├── redact-paths.ts         # paths redigidos pelo logger
│       └── request-context.ts      # AsyncLocalStorage do traceId
├── modules/
│   └── auth/
│       └── infra/
│           └── drizzle/
│               └── schema/         # um arquivo por tabela, nomeado pela tabela
│                   └── users.ts    # tabela `users`, dona do módulo auth
├── shared/                         # camada PURA, sem dono de módulo
│   └── errors/
│       └── app-error.ts            # taxonomia: AppError + as 6 categorias
└── main/
    ├── app.ts                      # compõe a aplicação: docs + rotas + deps, SEM escutar
    └── http.ts                     # entrypoint: sobe o servidor e trata shutdown

tests/
└── integration/
    ├── health.spec.ts              # suíte que precisa de Postgres de pé
    ├── setup/
    │   ├── migrate-test-database.ts  # globalSetup: aplica migrations commitadas antes da suíte
    │   └── test-database-url.ts      # única fonte da TEST_DATABASE_URL fora do CI
    └── users-schema.spec.ts        # prova a migration da tabela `users`
```

`src/infra/` é infra **sem dono** — o servidor, a config e a conexão do banco.
Futuramente, o logger. `src/modules/<m>/infra/` é a infra **daquele domínio**;
hoje só `auth` existe, e só com o schema Drizzle da tabela `users` — sem
domínio, use case ou endpoint ainda. Se você não consegue dizer de qual módulo
uma peça é, ela é global.

`src/main/` é o **composition root** — o único lugar autorizado a conhecer o
concreto de todos os módulos. Os entrypoints moram aqui (`http.ts` hoje;
`worker.ts` e `cron.ts` quando existirem) porque é aqui que o grafo é montado.
`app.ts` compõe a aplicação HTTP e devolve; quem abre porta é o entrypoint.

> `main/` não é "a pasta dos entrypoints". A regra de fronteira classifica
> `src/main/**` inteiro como `composition`, e é isso que permite a `app.ts`
> instanciar o banco e registrar rotas sem violar nada.

**Divisão de responsabilidade que já vale:** `infra/http/server.ts` constrói e
configura a instância Fastify e a devolve **sem nenhuma rota**. Quem registra
rotas, prefixos e plugins é `main/app.ts`. Essa linha é o que permite ao servidor
ser montado num teste sem arrastar o roteamento inteiro junto.

**E há uma segunda linha, entre compor e escutar.** `main/app.ts` devolve a
aplicação inteira — docs, rotas e dependências — **sem abrir porta**;
`main/http.ts` só chama `listen` e trata os sinais. Sem esse corte, montar o app
completo num teste exigiria subir servidor, e cada suíte acabaria remontando a
aplicação à mão — duas listas de registro para manter iguais, e um hook global
que existe em produção e falta no teste passa despercebido, com a suíte verde.

A conexão do banco é criada dentro do `buildApp`, que registra um hook `onClose`
fechando o pool. Assim `app.close()` é o único teardown: nem o entrypoint nem os
testes encerram conexão na mão.

---

## 3. Imports

Não há path alias. O projeto usa **subpath imports do Node**, declarados em
`package.json`, resolvidos pelo runtime — sem etapa de reescrita, sem bundler.

```jsonc
"imports": {
  "#modules/*": { "development": "./src/modules/*.ts", "default": "./dist/modules/*.js" },
  "#shared/*":  { "development": "./src/shared/*.ts",  "default": "./dist/shared/*.js"  },
  "#infra/*":   { "development": "./src/infra/*.ts",   "default": "./dist/infra/*.js"   },
  "#main/*":    { "development": "./src/main/*.ts",    "default": "./dist/main/*.js"    }
}
```

`#infra/*`, `#shared/*`, `#main/*` e `#modules/*` têm conteúdo hoje.
`tests/integration/users-schema.spec.ts` já importa
`#modules/auth/infra/drizzle/schema/users` — criar o primeiro módulo não exigiu mexer
no `package.json`, que é exatamente o que o mapeamento pronto de antemão
comprava.

`#main/*` existe porque a suíte de integração, que mora em `tests/`, precisa
alcançar `buildApp` — e a regra abaixo proíbe caminho relativo entre diretórios
de topo.

**Duas regras, com uma exceção:**

- **Entre diretórios de topo:** `#infra/...`, `#modules/...`, `#shared/...`
- **Dentro da mesma pasta:** relativo **com extensão `.js`** — `./user-mapper.js`.
  ESM com `nodenext` exige a extensão; sem ela o `tsc` falha com `TS2835`.

**A exceção:** `vitest.config.ts`, na raiz, importa
`./tests/integration/setup/test-database-url.js` por caminho relativo,
cruzando para `tests/`. Não há `#tests/*` no `imports` do `package.json` — a
suíte de teste não é código de produção — e um arquivo de config do Vite é
carregado pelo Vite, não pelo resolver do Node: não haveria como usar um
subpath import ali mesmo que o mapeamento existisse.

O `tsc` **não reescreve** esses especificadores: `dist/main/http.js` sai com
`import { env } from '#infra/config/env'` literal, e o Node resolve pela condition
`default` para `dist/`. É por isso que `package.json` precisa ir para a imagem de
produção.

> **A pegadinha mais fácil de não perceber.** Sem `--conditions=development`, com
> `dist/` presente, o processo sobe servindo **código compilado velho** enquanto
> você edita `src/` — sem nenhum aviso. O script `dev` já carrega a flag; não a
> remova.

### As três opções do tsconfig que sustentam isso

`rootDir`, `outDir` e `customConditions` **não são preferência**. Sem elas o
projeto não compila, e o modo de falha não é óbvio:

- Sem `customConditions: ["development"]`, o `tsc` resolve `#infra/...` pelo ramo
  `default` — ou seja, procura em `dist/`, que ainda não existe. Resultado:
  **`TS2307` em todo import `#`**.
- Sem `rootDir: "src"`, o `tsc` calcula a raiz comum das entradas. Basta o
  `include` alcançar um arquivo fora de `src/` para a saída virar `dist/src/...`,
  e aí o `imports` do `package.json`, que aponta para `./dist/infra/*.js`, passa a
  apontar para o nada.

Ambos verificados rodando uma config de biblioteca sobre esta árvore: 3 erros de
compilação e a saída no lugar errado.

**Onde cada uma mora.** `customConditions` fica no `tsconfig.json`, que vale para
o repositório inteiro. `rootDir` e `outDir` são preocupação de quem emite, e por
isso ficam só no `tsconfig.build.json` — ver §9.

---

## 4. Regras com dente

Regra que não é verificada por máquina é combinado, e combinado não sobrevive a
N projetos derivados. Estas falham no `pnpm lint`:

| | Regra | Mecanismo | Verificado |
|---|---|---|---|
| **R6** | Só `src/infra/config/env.ts` lê `process.env` | Biome `style/noProcessEnv` + `overrides` | ✅ fixture faz o lint sair com exit 1 |

Só R6 tem dente hoje, porque só R6 tem alvo hoje. As demais entram quando o código
que elas protegem existir — regra configurada sobre o vazio dá falsa sensação de
enforcement, que é pior que não ter.

**Por que R6 importa:** cada módulo vai declarar o schema Zod das suas env vars, e
o boot faz o merge. Se um módulo lesse `process.env` direto, esquecer de registrar
o schema no merge passaria despercebido — a variável simplesmente não seria
validada e chegaria `undefined` em produção. Com o acesso restrito e a config
injetada tipada, esquecer o merge vira erro de compilação.

### Legal / não legal

| ✅ | ❌ |
|---|---|
| `buildServer(env)` — a config chega injetada | `process.env.X` fora de `env.ts` |
| Toda env numérica com `.int().positive()` | `z.coerce.number()` cru — `PORT=` vira **`0`** em silêncio |
| Registrar rotas em `main/app.ts` | Registrar rotas dentro de `server.ts` |
| `import '#infra/http/server'` | `import '../../infra/http/server.js'` |
| Logar campo escolhido | Logar objeto de request ou entidade inteira |
| Dependência em versão exata | `^` ou `~` em qualquer dependência |

---

## 5. Configuração e log

**`env.ts` valida tudo no boot e mata o processo se algo estiver errado**, com a
lista de campos inválidos. Falhar no start é o comportamento desejado: env
inválida não deve virar bug três horas depois.

```
$ PORT= node dist/main/http.js
Variáveis de ambiente inválidas:
✖ Too small: expected number to be >0
  → at PORT
exit=1
```

O logger é o pino que já vem no Fastify. Três configurações merecem nota:

- **`genReqId: () => randomUUID()`** — o padrão do Fastify é um **contador por
  processo** (`req-1`, `req-2`). Com duas réplicas as duas emitem `req-1`, e um
  restart reinicia a contagem: grepar um `traceId` no agregador devolveria
  requisições sem relação entre si. É o mesmo valor que aparece no corpo de erro
  (§8), então o `traceId` de um print do usuário grepa a linha exata do log.
- **`logController: new LogController({ requestIdLogLabel: 'traceId' })`** — sem
  isso o Fastify loga `reqId` e o resto do sistema fala `traceId`, derrotando o
  grep único. A opção `requestIdLogLabel` de topo existe, mas está **deprecada** e
  sai no Fastify 6.
- **`redact`** cobre senha, token e headers de autenticação. Mas o `redact` do
  pino **não é recursivo** (`*.x` casa exatamente um nível) e o serializer `req`
  padrão do Fastify **não emite headers**. Então a lista é rede de segurança, não
  garantia: a regra que realmente protege é **nunca logar objeto inteiro**.

Em `NODE_ENV=development` o log sai por `pino-pretty`; em produção é JSON puro.

---

## 6. Banco de dados

**PostgreSQL**, acessado via `pg` (driver `node-postgres`) e Drizzle. A conexão
mora em `src/infra/database/client.ts`, infra global compartilhada por todos
os módulos — cada um dono das próprias tabelas, como descrito em `Posse de
tabela` mais abaixo.

```ts
// src/infra/database/client.ts
export type Database = NodePgDatabase | NodePgTransaction<EmptyRelations>
```

`DATABASE_URL` é validada em `env.ts` (§5), sem valor default — o boot falha
se faltar, mesma regra das demais variáveis.

Localmente, o Postgres sobe via `docker-compose.yml` (`postgres:18.4-alpine3.24`),
infra apenas — a aplicação roda no host:

```bash
docker compose up -d    # sobe os dois Postgres (dev e teste)
pnpm dev                # aplicação, no host
```

São **dois serviços**, a mesma imagem pinada:

| serviço | porta | banco | dados |
|---|---|---|---|
| `postgres` | 5432 | `api_clean_platform` | volume nomeado, persistente |
| `postgres-test` | 5433 | `api_clean_platform_test` | `tmpfs`, some quando o container para |

O serviço separado é o que garante que a suíte de integração nunca alcance dado
de desenvolvimento, e o `tmpfs` faz do restart do container o reset do estado.
O `globalSetup` do projeto `integration` no Vitest
(`tests/integration/setup/migrate-test-database.ts`) aplica as migrations
commitadas antes de qualquer teste rodar, então o banco vazio do `tmpfs` nunca
é um passo manual.

`drizzle.config.ts` (raiz) gera e aplica migrations via `pnpm db:generate` /
`pnpm db:migrate` (§10). Seu glob de schema
(`src/modules/*/infra/drizzle/schema/*.ts`) casa com
`src/modules/auth/infra/drizzle/schema/users.ts`, e a migration gerada dele está
commitada em `drizzle/`.

### Migration: sempre com `--name`, e nunca renomeie uma já aplicada

O drizzle-kit escreve **uma pasta por migration** — `<timestamp>_<nome>/` com
`migration.sql` e `snapshot.json` dentro. Sem `--name` ele sorteia um nome
aleatório (`bouncy_makkari`), que não diz nada numa pasta com trinta migrations:

```bash
pnpm db:generate --name=create_users_table
```

> ⚠️ **O nome da pasta é a chave de controle.** O migrator decide o que rodar
> comparando **nome**, não hash: `localMigrations.filter((lm) => !dbNamesSet.has(lm.name))`.
> Renomear uma migration já aplicada faz o drizzle tratá-la como nova e rodar de
> novo — num `CREATE TABLE`, erro de "relation already exists".
>
> O hash **é** gravado na tabela `drizzle.__drizzle_migrations`, mas nunca é
> comparado. Editar o SQL de uma migration já aplicada, portanto, não é
> detectado: passa em silêncio e o hash gravado fica velho. Migration commitada
> é imutável — corrija com uma nova (R4, forward-only).

`drizzle/` está **fora do Biome** (`biome.jsonc`): é saída de ferramenta, e o
`snapshot.json` gerado não bate com a formatação dele — lintar aquilo faria
`pnpm lint` quebrar depois de todo `db:generate`, e o `lint:fix` "resolveria"
reescrevendo um arquivo gerado.

`GET /health` consulta o banco (`select 1`) a cada chamada: responde `200` com
o banco no ar, `503` com o banco fora. Sem preflight no boot — o processo sobe
mesmo com o banco inatingível, para que `/health` consiga reportar a falha em
vez do processo crash-loopar.

### Posse de tabela

Cada módulo declara suas tabelas em `infra/drizzle/schema/`, **um arquivo por
tabela, nomeado pela tabela** — o diretório já diz "schema do Drizzle", então o
nome do arquivo não repete. Uma foreign key
só atravessa arquivos **do mesmo módulo**; entre módulos, referencia-se por id
sem constraint, e a integridade fica na aplicação. Todas as tabelas vivem em
`public` — um schema do Postgres por módulo foi considerado e adiado.
Raciocínio completo em
[`docs/superpowers/specs/2026-08-25-users-schema-first-migration-design.md`](docs/superpowers/specs/2026-08-25-users-schema-first-migration-design.md)
§5 (decisão 24).

---

## 7. HTTP e documentação da API

Um endpoint é **um arquivo** com schemas Zod, handler e rota juntos —
`infra/http/endpoints/health.ts` é o exemplo vivo. Os schemas Zod não são só
validação: são também a fonte da documentação, sem nenhuma duplicação.

**O que faz isso funcionar:** `server.ts` registra os compilers do
`fastify-type-provider-zod` (`setValidatorCompiler` / `setSerializerCompiler`).
Sem eles o Fastify recebe schema Zod onde espera JSON Schema e **falha em
runtime**.

`infra/http/openapi.ts` gera o documento OpenAPI 3.1 e serve a UI em `/docs`
(spec crua em `/docs/json`).

> **Só em `NODE_ENV=development`.** Nenhum ambiente deployado publica a
> superfície da API: fora de development as rotas nem existem, respondem 404.

Duas armadilhas de ordem, ambas silenciosas:

- **`registerOpenApi` tem que rodar antes das rotas.** O `@fastify/swagger`
  engancha no hook `onRoute`; rota registrada antes dele simplesmente não
  aparece na spec — sem erro, sem aviso.
- **`transform: jsonSchemaTransform` é obrigatório.** É ele que converte o Zod
  em JSON Schema. Sem ele a spec sai vazia.

Os endpoints checados por `/health` vivem em `infra/health/checks/`, um arquivo
por dependência. O endpoint só agrega e traduz para HTTP — quando entrar Redis
ou uma API externa, cria-se o arquivo irmão em vez de crescer o handler.

---

## 8. Erros

Toda falha responde no **mesmo envelope**, com um `code` estável que o cliente
pode ramificar:

```jsonc
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found", "traceId": "6eedbea3-…" } }
```

`code` é contrato e serve de chave de i18n. **`message` não é contrato** — existe
para log e debug, e nunca deve ser exibida crua num app traduzido, ou vira texto
em inglês numa tela em português.

### A taxonomia é semântica, não protocolar

`src/shared/errors/app-error.ts` é camada pura e **não menciona HTTP**. "Não
encontrado" e "conflito" são conceitos de aplicação: significam a mesma coisa num
worker ou num cron, onde status code não quer dizer nada.

```ts
export abstract class AppError extends Error {
  abstract readonly code: string
}
export abstract class NotFoundError extends AppError {}
// ConflictError, UnauthorizedError, ForbiddenError, ValidationError, BusinessRuleError
```

O `code` é **declarado**, nunca derivado do nome da classe. Derivar faria o nome
da classe virar contrato público em silêncio: um PR de renome passaria no
typecheck, no lint e em todo teste, e quebraria o `switch (error.code)` de todo
app em produção sem deixar rastro no diff.

### O mapa não cresce

`infra/http/error-handler.ts` é o **único** lugar que traduz erro em status HTTP.
(Um endpoint declara os status das respostas dele — `health.ts` publica `200` e
`503` — mas nenhum endpoint decide o status de uma falha.) Cem erros de domínio
continuam caindo nestas seis linhas:

| categoria | status |
|---|---|
| `ValidationError` | 400 |
| `UnauthorizedError` | 401 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `BusinessRuleError` | 422 |

As seis são **irmãs** — todas estendem `AppError` direto. Se alguma passar a
estender outra, o mapa começa a depender da ordem das linhas.

O use case só faz `throw`; o endpoint não tem `try/catch`.

### As quatro coisas que não são da taxonomia

| origem | resposta | por quê |
|---|---|---|
| validação do Fastify/Zod | 400 `VALIDATION_ERROR` + `details[]` | chega como `Error` com `FST_ERR_VALIDATION`, não como `ValidationError` — sem esse ramo, todo payload inválido daria 500 |
| 4xx do próprio Fastify (415, 413…) | status preservado, `code` `BAD_REQUEST` | 4xx é culpa do cliente; virar 500 encheria o log de erro interno falso |
| rota inexistente | 404 `ROUTE_NOT_FOUND` | sem `setNotFoundHandler` o 404 sai no formato do Fastify e fura o envelope |
| qualquer outra coisa | 500 `INTERNAL_SERVER_ERROR` | corpo genérico, **sem stack e sem mensagem de driver**; o log registra tudo |

Um `AppError` que estenda a base **fora** das seis categorias também cai no
último ramo: é erro de programação, não problema do cliente.

O `code` do 4xx do Fastify é um só, e não uma tabela por `FST_ERR_*`: repassar o
código do framework faria o nome dele virar contrato público, e distinguir 413 de
415 é o que o status HTTP já faz.

> **Cuidado ao testar o 415:** o Fastify traz parser nativo para
> `application/json` **e** `text/plain`. Nenhum dos dois dispara 415 — foi
> preciso um `application/xml` para o ramo aparecer.

### Erro de validação carrega detalhe por campo

```jsonc
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid payload",
    "details": [
      { "field": "email",    "code": "INVALID_FORMAT" },
      { "field": "password", "code": "TOO_SMALL" }
    ],
    "traceId": "6eedbea3-…"
  }
}
```

O `code` do `details` é **o código do issue do Zod em maiúsculo**, sem tabela de
tradução:

| issue do Zod | `code` publicado |
|---|---|
| `invalid_type` | `INVALID_TYPE` |
| `too_small` | `TOO_SMALL` |
| `too_big` | `TOO_BIG` |
| `invalid_format` | `INVALID_FORMAT` |
| `not_multiple_of` | `NOT_MULTIPLE_OF` |
| `unrecognized_keys` | `UNRECOGNIZED_KEYS` |
| `invalid_value` | `INVALID_VALUE` |
| `custom`, `invalid_union`, `invalid_key`, `invalid_element` | `INVALID_VALUE` |

**Por que não há tabela.** Ela seria uma função identidade escrita à mão: medido
com um payload real, 8 dos 11 casos saíam idênticos ao `toUpperCase()`. Os três
que diferiam eram os que liam `params.origin` — interno do Zod, e o único campo
que o próprio Zod declara aberto (`(string & {})`).

A lista de quatro que colapsam para `INVALID_VALUE` **não é tradução, é
exclusão**: esses códigos descrevem como o schema foi composto, não o que há de
errado com o dado. `custom` conta ao cliente que existe um `.refine()`.

**O que protege o contrato** é o teste de vocabulário em `error-handler.spec.ts`,
que passa um payload inválido pelo Zod real e fixa todos os códigos publicados.
Uma tabela com `default` faria o contrário: um code renomeado pelo Zod viraria
`INVALID_VALUE` em silêncio, com a suíte verde, porque os fixtures do teste
continuariam usando a string antiga.

`field` é omitido quando o issue aponta para o corpo inteiro em vez de um campo —
é o caso de `unrecognized_keys`.

### `traceId`: o mesmo no log e no corpo

`infra/observability/request-context.ts` isola um `AsyncLocalStorage` em três
funções. Um hook `onRequest` abre o escopo com o `request.id`, e tudo a jusante
— rotas, hooks, error handler e not-found handler — lê o mesmo valor sem receber
parâmetro nenhum.

O caminho explícito (`ctx` em toda assinatura) foi descartado por ser viral:
contamina até a assinatura dos repositórios, e esquecer de repassar quebra a
correlação em silêncio.

> Hoje o error handler poderia usar `request.id` direto — o ALS ainda não tem
> consumidor fora do fluxo de request. Ele existe assim mesmo porque num
> boilerplate o que não entra hoje não chega aos apps já derivados, e porque é
> ele que mantém a migração para OpenTelemetry como troca de **um arquivo**.

### Onde tudo isso é registrado

Error handler, not-found handler e o hook do ALS ficam em **`buildServer`**, não
em `main/app.ts`. A regra "`server.ts` não registra rotas" continua valendo:
isto é configuração da instância, não roteamento. O efeito é que todo servidor
montado num teste já herda o contrato de erro inteiro.

---

## 9. Testes

**Vitest**, um runner para as duas pistas — a separação é por *project*, não por
ferramenta:

| project | onde | precisa de banco | comando |
|---|---|---|---|
| `unit` | `src/**/*.spec.ts`, colocado ao lado do código | não | `pnpm test:unit` |
| `integration` | `tests/integration/**/*.spec.ts` | sim | `pnpm test:integration` |

`pnpm test` roda as duas. A pista de integração usa `fileParallelism: false`,
porque todos os arquivos compartilham o mesmo Postgres.

**Nenhum teste lê `process.env`.** A env da suíte é injetada em `test.env`, no
`vitest.config.ts`. Com isso R6 continua valendo sem exceção nenhuma no
`biome.jsonc`, e `import { env } from '#infra/config/env'` já chega válido dentro
do teste.

**Não há `resolve.conditions` na config, de propósito.** O Vite já pede a
condition `development` em modo de teste, então `#infra/*` resolve para `src/` e
nunca para o `dist/` — verificado plantando um sentinela no `dist/` e observando
o `src/` vencer. Sobrescrever esse array substituiria os defaults do Vite e
criaria justamente o risco que ele evitaria.

### Duas peças de produção têm a forma que têm por causa disto

- **`parseEnv(source)`** separa a validação do efeito colateral. Sem ela,
  importar `env.ts` num spec dispara o `process.exit(1)` do boot e mata o worker
  do Vitest — comprovado antes de existir.
- **`buildServer(env, { logStream })`** recebe o destino do log por injeção;
  destino de log é mundo externo pela definição do §1. É o que permite testar a
  redação do §5 contra o logger real de produção, sem trazer `pino` como
  dependência direta. Funciona porque `stream` e `transport` são mutuamente
  exclusivos no pino, e o `pino-pretty` só é ligado em development.

O que a suíte cobre hoje: os casos "não legal" do §4 dentro de `parseEnv`, a
redação do §5 — inclusive a limitação de um nível só, que fica documentada como
teste — e `GET /health` respondendo `200` e `503` contra Postgres real.

Soma-se a isso o contrato de erro do §8 inteiro: as seis categorias mapeadas uma
a uma, a tabela de tradução do Zod linha a linha, e a garantia de não-vazamento
— um erro inesperado responde genérico e a mensagem interna aparece **só** no
log.

O helper de migration da suíte é o `globalSetup` do projeto `integration`
(`tests/integration/setup/migrate-test-database.ts`, §6): aplica as migrations
commitadas antes de qualquer teste rodar. O `tmpfs` do `postgres-test` ainda é
quem zera o cluster, mas só **entre restarts do container** — dentro de uma
mesma execução ele não isola uma spec da outra.

Essa isolação é por teste, não por suíte: `users-schema.spec.ts` limpa a
tabela com `db.delete(users)` no **`beforeEach`**, não no `afterEach`. Uma
suíte pode terminar com linhas na tabela, e a limpeza só acontece no início do
próximo teste — quem escrever a próxima spec de integração não pode assumir
banco vazio ao entrar, e precisa limpar as próprias tabelas no `beforeEach`.

---

## 10. Comandos

```bash
pnpm dev               # tsx + watch, resolve # para src/
pnpm build             # tsc -p tsconfig.build.json -> dist/ (sem os specs)
pnpm start             # node dist/main/http.js, resolve # para dist/
pnpm typecheck         # tsc --noEmit — cobre src/, tests/ e os arquivos de config
pnpm test              # Vitest: unit + integração
pnpm test:unit         # só a pista sem I/O
pnpm test:integration  # só a pista com Postgres real (docker compose up -d antes)
pnpm test:watch        # Vitest em watch
pnpm lint              # biome check  (formatação + lint + ordem de imports)
pnpm lint:fix          # biome check --write
pnpm db:generate --name=create_users_table   # gera migration a partir do schema dos módulos
                                             # SEMPRE com --name; sem ele o nome é sorteado (§6)
pnpm db:migrate        # drizzle-kit migrate — aplica migrations pendentes
```

O servidor sobe com uma única rota de aplicação, `GET /health` (§7) — mais
`/docs` e `/docs/json`, que só existem em development. Qualquer outro caminho
responde **404**, e isso é o esperado.

---

## 11. Versões

**Toda dependência é pinada em versão exata. Nenhum `^`, nenhum `~`** — nem em
`dependencies`, nem em `devDependencies`. Num boilerplate copiado N vezes, caret
significa que dois apps gerados do mesmo commit podem resolver árvores
diferentes, e a divergência aparece como bug que não reproduz.

O pin não é só do estado atual: `savePrefix: ''` faz todo `pnpm add` futuro
gravar exato, sem ninguém precisar lembrar.

Atualizar é ato deliberado — `pnpm outdated` mostra, e a subida é um commit que
passa pela suíte.

### O que garante a versão do Node

| mecanismo | o que faz | é portão? |
|---|---|---|
| `.nvmrc` | fnm/nvm trocam a versão ao entrar na pasta; CI lê com `node-version-file` | não — conveniência |
| `engines` + `engineStrict: true` | `pnpm install` **recusa** em versão fora da faixa | **sim** — exit 1 |
| `packageManager` | Corepack fixa a versão do pnpm | sim, com Corepack ligado |

Sozinho, `engines` só **avisa** e sai com exit 0. É o `engineStrict` no
`pnpm-workspace.yaml` que o transforma em portão.

> **`lib` do tsconfig acompanha o runtime, não o `target`.** `lib: ["es2024"]`
> sozinho esconde do compilador APIs que o Node 24 **tem** — iterator helpers
> (`.map`/`.toArray`), métodos de `Set` (`union`) e `Error.isError`. O sintoma
> engana: o dev bate em `TS2339`, conclui que o Node não suporta e escreve o
> workaround. Por isso o `lib` carrega os blocos `ESNext.*` do
> `@tsconfig/node24`.

> **`@types/node` acompanha o major do Node, não o `latest` do npm.** Hoje o
> `latest` desse pacote é 26.x, que descreve o Node 26 — *current*, não LTS.
> Instalá-lo sobre o Node 24 faz o compilador aceitar APIs que não existem em
> runtime. Rodamos Node 24, logo `@types/node` é 24.x.

---

## 12. Decisões travadas

**TypeScript pinado em `7.0.2` exato, sem caret.** O TS 7 é o port em Go e mudou o
`exports` do pacote: a raiz passou a exportar só a versão, e a API do compilador
foi para `./unstable/*`. Consequência prática — **`typescript-eslint` e
`dependency-cruiser` não funcionam com TS 7**, porque ambos consomem a API antiga.
O `dependency-cruiser` é o pior dos dois: ele emite *aviso*, não erro, e sai com
**exit 0** e `0 modules cruised`, ou seja, CI verde sem enforçar nada.

**Biome no lugar de ESLint + Prettier.** Decorre do parágrafo acima: o Biome é um
binário Rust com **zero dependências JS**, com parser próprio — a versão do
TypeScript é indiferente para ele. Além disso `noProcessEnv` (R6) é regra nativa, e
`noRestrictedImports` casa o especificador **como string**, o que resolve
fronteira sem precisar de resolver de módulo.

**Custo aceito:** o Biome não detecta ciclo de dependência e não gera grafo. Sem
lint type-aware.

**`pnpm-workspace.yaml` não faz deste repo um monorepo.** Sem a chave
`packages:`, isto é um pacote único. O arquivo existe porque o pnpm 11 deixou de
ler o campo `pnpm` do `package.json`, e é onde moram `allowBuilds`,
`engineStrict` e `savePrefix`.

**Sem Turborepo.** Ele orquestra tarefas entre pacotes e cacheia saída de tarefa;
aqui há um pacote só, e o pipeline inteiro custa ~1,1 s — o overhead do próprio
turbo fica na mesma ordem. Passaria a valer se isto virasse monorepo de verdade, e
aí o primeiro passo seria pnpm workspaces, não ele. Módulos aqui são
**diretórios**, não pacotes; `worker` e `cron`, quando existirem, são entrypoints
do mesmo pacote.

---

## 13. O que ainda não existe

Listado para não ser confundido com omissão, sem detalhar o que não foi construído:

módulos de negócio · regra de fronteira no lint · Docker

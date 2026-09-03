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

A taxonomia de erro em `src/shared/` (§8) foi o primeiro código puro do
repositório — nenhum import, nenhuma menção a protocolo. Hoje o módulo `auth`
tem uma camada pura inteira: entidade, value objects, use case e os contratos de
repositório e provider. Nenhum desses arquivos importa Fastify, Drizzle, `pg` ou
`process.env`, e é isso que os torna testáveis em milissegundos, sem banco.

O princípio está aqui porque é ele que decide onde cada arquivo novo vai cair.

---

## 2. A árvore

```text
src/
├── infra/                          # infra GLOBAL, sem dono de módulo
│   ├── config/
│   │   ├── env.ts                  # ÚNICO lugar que lê process.env
│   │   └── env.spec.ts             # unitário colocado
│   ├── database/
│   │   ├── client.ts               # pool pg + instância Drizzle
│   │   ├── driver-error.ts         # converte erro do driver antes de sair do infra/
│   │   ├── transaction-runner.ts   # abre a transação, faz commit/rollback e recusa aninhamento
│   │   └── unit-of-work.ts         # createUnitOfWork(runner, buildRepos) — casca genérica (decisão 22)
│   ├── health/
│   │   └── checks/
│   │       └── database-check.ts   # um arquivo por dependência checada
│   ├── http/
│   │   ├── server.ts               # instância Fastify, SEM rotas
│   │   ├── server.spec.ts          # unitário colocado
│   │   ├── auth-guard.ts           # preHandler genérico; verificador injetado, sem import de #modules/*
│   │   ├── openapi.ts              # OpenAPI + UI dos docs (só em development)
│   │   ├── errors/                 # o contrato de erro; os três mudam juntos
│   │   │   ├── error-handler.ts    # ÚNICO lugar que traduz erro em status HTTP
│   │   │   ├── error-handler.spec.ts
│   │   │   ├── error-response.ts   # schema Zod do envelope — o único público dos três
│   │   │   ├── validation-issues.ts     # tradução Zod -> códigos do contrato
│   │   │   └── validation-issues.spec.ts
│   │   └── endpoints/
│   │       └── health.ts           # GET /health — agrega os checks
│   ├── providers/                   # adapters dos contratos de shared/ports/
│   │   ├── system-clock.ts
│   │   ├── system-clock.spec.ts     # unitário colocado
│   │   ├── uuid-id-generator.ts
│   │   └── uuid-id-generator.spec.ts
│   └── observability/
│       ├── error-serializer.ts     # serializer do err do pino (sanitiza params)
│       ├── logger.ts               # createLogger: o pino que todo entrypoint usa
│       ├── redact-paths.ts         # paths redigidos pelo logger
│       └── request-context.ts      # AsyncLocalStorage do traceId
├── modules/
│   └── auth/                        # domínio + infra do módulo
│       ├── config.ts                # schema Zod das env vars do módulo (decisão 14)
│       ├── entities/user.ts         # puro — estado em campos `#`
│       ├── value-objects/           # puro — email.ts, password.ts
│       ├── repositories/            # SÓ contratos — users-repository.ts, refresh-tokens-repository.ts
│       ├── ports/                   # SÓ contratos — hash-provider.ts, token-signer.ts
│       ├── use-cases/               # puro (+ .spec.ts colocado) — register-user.ts, login-user.ts, get-user-profile.ts, refresh-token.ts, logout.ts, logout-all.ts
│       ├── services/                # domain service puro — refresh-token-issuer.ts
│       ├── errors/                  # um arquivo por erro do módulo — inclui invalid-credentials-error.ts, refresh-token-reused-error.ts
│       ├── container.ts             # factory do container do módulo
│       └── infra/                   # tudo que toca o mundo externo
│           ├── drizzle/
│           │   ├── schema/users.ts  # um arquivo por tabela, nomeado pela tabela
│           │   ├── user-mapper.ts   # entidade -> row (decisão 20)
│           │   ├── drizzle-users-repository.ts
│           │   ├── drizzle-refresh-tokens-repository.ts
│           │   └── auth-repositories.ts    # monta AuthRepos — único lugar que instancia os repositórios do módulo
│           ├── in-memory/           # repositório de teste (decisão 09)
│           ├── providers/           # adapters dos contratos de ports/ — argon2, jose
│           └── http/
│               ├── constants.ts     # status HTTP e tag do OpenAPI do módulo
│               ├── refresh-cookie.ts  # atributos do cookie de refresh, em UM lugar
│               ├── endpoints/       # 1 arquivo = schema + handler + rota
│               │   ├── register.ts  # POST /auth/register
│               │   ├── login.ts     # POST /auth/login
│               │   ├── refresh.ts   # POST /auth/refresh
│               │   ├── logout.ts    # POST /auth/logout
│               │   ├── logout-all.ts # POST /auth/logout-all
│               │   └── me.ts        # GET /auth/me
│               └── routes.ts        # agregador fino do módulo
├── shared/                         # camada PURA, sem dono de módulo
│   ├── errors/
│   │   └── app-error.ts            # taxonomia: AppError + as 6 categorias
│   └── ports/                       # contratos transversais
│       ├── clock.ts                 # IClock — tempo entra por aqui (R7)
│       ├── id-generator.ts          # IIdGenerator — identidade entra por aqui (R7)
│       └── unit-of-work.ts          # IUnitOfWork<TRepos> — contrato genérico e transversal (decisão 22)
└── main/
    ├── container.ts                 # composition root: junta os módulos
    ├── app.ts                      # compõe a aplicação: docs + rotas + deps, SEM escutar
    └── http.ts                     # entrypoint: sobe o servidor e trata shutdown

tests/
└── integration/
    ├── drizzle-users-repository.spec.ts  # repositório Drizzle contra Postgres real
    ├── health.spec.ts              # suíte que precisa de Postgres de pé
    ├── register.spec.ts            # POST /auth/register fim a fim
    ├── login.spec.ts                # POST /auth/login fim a fim
    ├── refresh-token.spec.ts        # POST /auth/refresh fim a fim
    ├── logout.spec.ts               # logout e logout-all fim a fim
    ├── me.spec.ts                   # GET /auth/me fim a fim
    ├── setup/
    │   ├── migrate-test-database.ts  # globalSetup: aplica migrations commitadas antes da suíte
    │   └── test-database-url.ts      # única fonte da TEST_DATABASE_URL fora do CI
    └── users-schema.spec.ts        # prova a migration da tabela `users`
```

`src/infra/` é infra **sem dono** — o servidor, a config e a conexão do banco.
Futuramente, o logger. `src/modules/<m>/infra/` é a infra **daquele domínio**;
hoje só `auth` existe, e ele é o modelo completo: camada pura em `entities/`,
`value-objects/`, `use-cases/` e nos contratos de `repositories/` e `ports/`,
com os adapters — Drizzle, in-memory, argon2, HTTP — isolados sob `infra/`. Se
você não consegue dizer de qual módulo uma peça é, ela é global.

`src/main/` é o **composition root** — o único lugar que conhece o concreto de
**todos** os módulos ao mesmo tempo. Cada módulo conhece o próprio concreto no
seu `container.ts`, e o `main/` apenas junta as fatias; a divisão está desenhada
logo abaixo. Os entrypoints moram aqui (`http.ts` hoje; `worker.ts` e `cron.ts`
quando existirem) porque é aqui que o grafo é montado. `app.ts` compõe a
aplicação HTTP e devolve; quem abre porta é o entrypoint.

> `main/` não é "a pasta dos entrypoints". A regra de fronteira classifica
> `src/main/**` inteiro como `composition`, e é isso que permite a `app.ts`
> instanciar o banco e registrar rotas sem violar nada.

### A regra de fronteira, enunciada

O §1 dá o princípio; esta tabela é ele por tipo de arquivo. É o que o lint de
fronteira vai configurar quando entrar — e é por isso que ela precisa estar
escrita antes, não depois.

| Elemento | Padrão | Pode importar |
|---|---|---|
| `pure` | `src/modules/*/{entities,value-objects,repositories,ports,use-cases,services,dtos,errors}/**` · `src/modules/*/config.ts` · `src/shared/**` | só `pure` |
| `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · o `module-infra` **do próprio módulo** |
| `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| `composition` | `src/modules/*/container.ts` · `src/main/**` | tudo |
| `test` | `**/*.spec.ts` · `tests/**` · `**/fixtures/**` · `**/in-memory/**` | tudo |

**`composition` e `test` são exceções deliberadas, não brechas.** O composition
root existe justamente para conhecer o concreto, e o teste unitário precisa
alcançar o repositório in-memory. Deixá-las implícitas é o que produz "exceção
não documentada" e esvazia a regra.

`fixtures/` e `in-memory/` entram em `test` **pelo nome da pasta**, não pelo
caminho: os dois vivem sob `src/`, e sem esta linha a tabela os classificaria
como código de produção — `src/infra/config/fixtures/` como `global-infra`,
`src/modules/*/infra/in-memory/` como `module-infra`. São os mesmos dois globs
que o `tsconfig.build.json` já exclui do build, e pela mesma razão: são dublês,
e um deles carrega um `JWT_SECRET` fixo. Classificá-los como produção faria o
lint de fronteira aprovar exatamente o import que deveria barrar.

A linha `module-infra` também resolve o cruzamento entre módulos: o `infra/` de
um módulo não alcança o `infra/` de outro.

**`services/` é a linha mais nova, e o que mora ali é estreito:** uma operação de
domínio que precisa de colaboradores e não pertence a uma entidade só. O
`RefreshTokenIssuer` é o caso que a criou — cunhar um elo da cadeia de refresh
(gerar opaco, digerir, montar a entidade) é a mesma operação no `login` e nos
dois ramos da rotação, e a entidade não pode conhecer porta. Sem ela o
`LoginUserUseCase` receberia nove colaboradores.

O que **não** mora ali: orquestração de caso de uso, que é `use-cases/`; e
qualquer coisa que toque o mundo externo, que é `infra/`. Um `services/` que
comece a receber repositório é sinal de que virou use case com outro nome.

> A pasta nasceu numa fatia **sem** esta linha, e a auditoria a pegou como
> `LAYER-UNKNOWN` — arquivo de produção que nenhuma regra classificava. É o
> argumento concreto a favor de a tabela existir antes do lint: ela pegou o que
> a revisão humana deixou passar.

**Duas regras do Unit of Work (decisão 22) que nem o compilador nem o lint
alcançam** — a tabela acima classifica arquivo por caminho, e as duas a seguir
dependem do que o código faz dentro dele:

- **Use case que recebe o Unit of Work não recebe também um repositório
  direto.** O repositório injetado como singleton no container escreve numa
  conexão autocommit; chamá-lo dentro do callback do `uow` compila, passa no
  teste unitário contra um dublê e só quebra a atomicidade em produção. Tudo
  que o callback escreve tem que vir do `repos` que ele recebe como parâmetro.
- **Três coisas não podem entrar no callback do `uow`,** porque a transação
  fica aberta pela duração inteira dele: I/O externo (e-mail, HTTP — persiste
  dentro, envia depois do commit), trabalho pesado de CPU (argon2 — calcula
  antes e passa o resultado pronto) e qualquer escrita que precise sobreviver a
  uma falha (um contador de tentativas de força bruta é autocommit de
  propósito; um rollback apagaria o próprio registro da falha que ele existe
  para guardar).

#### E quem pode importar `composition`?

A tabela acima diz o que cada elemento **importa**. Falta a direção contrária, e
ela não é óbvia — `composition` não aparece na coluna direita de nenhuma linha,
o que leria como "ninguém pode importar um container". Não é isso:

| Quem importa | O quê | Como |
|---|---|---|
| `src/main/**` | `modules/*/container.ts` de qualquer módulo | valor — é o composition root juntando as fatias |
| `src/modules/<m>/infra/**` | o `container.ts` **do próprio módulo** | **só o tipo** |
| qualquer outro | — | proibido |

A segunda linha é a que surpreende. `routes.ts` e `endpoints/register.ts` fazem
`import type { AuthContainer }` porque a decisão 23 tipa o plugin pela fatia que
ele recebe — é o que transforma "alcançar o use case de outro módulo" em erro de
compilação. Sendo `import type`, some na compilação: nenhuma dependência em
runtime, nenhum ciclo.

A terceira linha é literal: o `container.ts` de um módulo nunca é alcançado pelo
`infra/` de outro módulo, nem pela camada pura.

Sem esta seção, a configuração literal da tabela quebraria o CI no primeiro
módulo que existe — que é exatamente o `auth` de hoje.

### O container: cada módulo exporta o seu, `main/` compõe

Injeção de dependência aqui é **container manual tipado**. Sem biblioteca, sem
string key, sem decorator: duas funções, e o grafo inteiro legível.

```ts
// modules/auth/container.ts — o módulo conhece o concreto
export function makeAuthContainer(db: Database, config: AuthConfig) {
  const usersRepository = new DrizzleUsersRepository(db)
  const hashProvider = new Argon2HashProvider()
  const clock = new SystemClock()
  const idGenerator = new UuidIdGenerator()
  const tokenSigner = new JwtTokenSigner(config, clock)

  return {
    registerUser: new RegisterUserUseCase(usersRepository, hashProvider, clock, idGenerator),
    loginUser: new LoginUserUseCase(usersRepository, hashProvider, tokenSigner),
    getUserProfile: new GetUserProfileUseCase(usersRepository),
    verifyAccessToken: (token: string) => tokenSigner.verify(token),
  }
}
export type AuthContainer = ReturnType<typeof makeAuthContainer>

// main/container.ts — o composition root junta os módulos
export function makeContainer(db: Database, env: Env) {
  return { auth: makeAuthContainer(db, env) }
}
```

Tipagem 100% inferida, e o mesmo grafo serve os três entrypoints porque é
montado **sem Fastify** — requisito para worker e cron existirem depois sem
duplicar wiring. `env` chega inteiro em `makeContainer`, e cada módulo declara
só a fatia que precisa — `makeAuthContainer` pede `AuthConfig`, então `auth` nem
enxerga `DATABASE_URL`. Tipagem estrutural dá de graça a regra da decisão 23,
sem nenhum código de recorte. Objeto stateless (repositório, provider) é
singleton no container; o custo de um `new` é nanosegundos contra milissegundos
de rede, e o problema do `new` no handler nunca foi performance, foi
acoplamento.

**O plugin do módulo recebe só a fatia dele.**

```ts
await app.register(authRoutes, { prefix: AUTH_PREFIX, container: container.auth })
```

Alcançar o use case de outro módulo vira **erro de compilação** — o tipo
`AuthContainer` simplesmente não tem o campo. É garantia do compilador, não
combinado que depende de lint.

> **O grafo é montado no `buildApp`, não no `http.ts`.** `buildApp` é o
> composition root que as suítes exercitam; se o container nascesse no
> entrypoint, as rotas do módulo existiriam em produção e faltariam no teste —
> exatamente o buraco que o corte entre compor e escutar (§2) fechou.

**Onde mora o DTO de um use case.** No arquivo do próprio use case.
`RegisterUserCommand` e `RegisterUserResult` são 1:1 com `RegisterUserUseCase` e
mudam sempre junto — mesmo raciocínio que mantém schema, handler e rota no mesmo
arquivo de endpoint. A pasta `dtos/` está prevista na convenção para o dia em que
um DTO passar a ser compartilhado entre use cases — não existe ainda, e criá-la
vazia só adicionaria um diretório que ninguém abre.

**Duas portas transversais, e por que são duas.** `IClock` e `IIdGenerator` moram
em `shared/ports/`, com adapters em `infra/providers/`. Estão separadas de
propósito: id de entidade e segredo criptográfico têm perfis de segurança e
motivos de mudar diferentes — trocar o id de UUIDv4 para v7 não tem relação com a
entropia de um refresh token. Juntas numa porta só, o use case que quer apenas um
id receberia uma porta que também cunha segredos.

Pela mesma economia, um contrato nasce com os métodos — ou os campos — que têm
consumidor. O payload do access token tem `sub`, `iat` e `exp`, e não `jti`,
porque nada no sistema consome uma denylist — é a decisão 11 quem recusou essa
ideia. Campo sem consumidor é código que N apps derivados copiam sem nunca
exercitar.

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
- **Dentro do próprio galho** — mesma pasta ou uma subpasta dela: relativo **com
  extensão `.js`** — `./user-mapper.js`, `./schema/users.js`,
  `./endpoints/register.js`. ESM com `nodenext` exige a extensão; sem ela o `tsc`
  falha com `TS2835`.

Subir de pasta com `..` fica fora do padrão: de `value-objects/` para `errors/`
escreve-se `#modules/auth/errors/invalid-email-error`, não `../errors/...`. O
critério é legibilidade sob refatoração — um caminho `#` continua correto depois
de mover o arquivo; um `../../..` não.

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

**Só R6 tem dente hoje — e o motivo mudou.** A redação anterior desta seção dizia
que as outras entrariam "quando o código que elas protegem existir". Esse código
agora existe: a fatia do `POST /auth/register` criou a camada pura, o primeiro
repositório e a primeira fronteira de módulo real. O critério foi satisfeito e
nada foi configurado, então isto deixou de ser desenho e virou **dívida**, com o
tamanho abaixo:

| Regra | Alvo desde | Mecanismo possível | Situação |
|---|---|---|---|
| **R7** — camada pura não produz valor não determinístico | `modules/auth/{entities,value-objects,use-cases}` | Biome `noRestrictedGlobals`/`noRestrictedImports` restrito por caminho | ⚠️ só revisão humana |
| **Fronteira** — quem importa quem | `modules/auth/**` | `dependency-cruiser` (a tabela do §2 é a config) | ⚠️ só revisão humana |
| **R1** — repositório usa só a API core do Drizzle | `infra/drizzle/drizzle-users-repository.ts` | lint proibindo `db.query.*` | ⚠️ só revisão humana |
| **R2** — coluna sempre nomeada explicitamente | `infra/drizzle/schema/users.ts` | difícil de lintar; teste de schema cobre na prática | ⚠️ aceito |
| **R4** — migrations forward-only | `drizzle/` | difícil de lintar; convenção + review | ⚠️ aceito |

As duas primeiras são as que valem automação: R7 e a fronteira são regras que
quebram em silêncio e que um revisor cansado deixa passar. R2 e R4 são
convenções que o teste de integração e o próprio formato da pasta já tornam
visíveis.

> **A regra que existia e não pegou.** A tabela abaixo já proibia "logar objeto
> de request ou entidade inteira" desde antes desta fatia. O vazamento de hash
> que a revisão final encontrou (§8) era exatamente essa forma — por um objeto de
> **erro**, não de entidade. A regra estava certa; nada a verificava, e ninguém
> leu a linha na hora de escrever `request.log.error({ err })`. É o argumento
> mais concreto que este projeto tem a favor de dar dente às cinco acima.

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

O logger é um **pino próprio**, criado por `createLogger` em
`infra/observability/logger.ts` e entregue ao Fastify por `loggerInstance`. Ele
saiu de dentro do `server.ts` quando a transação passou a poder registrar
tentativas de retry: o composition root é compartilhado por `http`, `worker` e
`cron` (decisão 10), e um worker que montasse o próprio pino duplicaria o
`REDACT_PATHS` — a lista que mantém hash de senha e token fora do log. `buildApp`
cria um só e o passa aos dois lados.

Três configurações merecem nota:

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

### Limites de conexão, e por que subir o pool é a alavanca errada

Cinco variáveis governam o pool e os timeouts, todas com default em `env.ts`:
`DATABASE_POOL_MAX` (10), `DATABASE_CONNECTION_TIMEOUT_MS` (5000),
`DATABASE_STATEMENT_TIMEOUT_MS` (10000), `DATABASE_LOCK_TIMEOUT_MS` (5000) e
`DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (10000). Elas passaram a importar
quando o Unit of Work nasceu: uma conexão deixou de ser retida pela duração de
uma **query** e passou a ser retida pela duração de um **callback**.

O instinto ao ver um pool de 10 é aumentá-lo. Num sistema com várias réplicas
isso é a alavanca errada, porque o custo é multiplicativo:

```
instâncias × DATABASE_POOL_MAX  ≤  max_connections − reserva
```

Com os defaults do Postgres (`max_connections` 100, 3 reservadas), **9
instâncias × 10 já encosta no teto**. Conexão do Postgres não é thread: cada uma
é um processo backend com memória própria. Passado o ponto em que os cores do
banco saturam, pool maior só troca fila no app por contenção no banco — pior,
porque o banco é compartilhado e a fila é local.

Quando `instâncias × max` encosta no teto, a resposta é um **pooler em
transaction mode** (PgBouncer, RDS Proxy, Supavisor) na frente. O boilerplate já
é compatível: o Drizzle manda prepared statements **anônimos** por default.
**Chamar `.prepare()` numa query quebra essa compatibilidade**, e a falha
aparece longe da causa.

Duas armadilhas registradas:

- **`0` num timeout não desliga.** O `pg` envia os três sob `if (params.x)`, então
  um zero simplesmente não é enviado e vale o que o servidor tiver — que num
  Postgres gerenciado pode ser um valor de parameter group.
- **Valor em branco é recusado no boot.** Sem isso, `VAR=` viraria `0` pela
  coerção e desligaria a proteção em silêncio — falha aberta.

Desenho completo em
[`specs/2026-08-30-connection-limits-design.md`](docs/superpowers/specs/2026-08-30-connection-limits-design.md).

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

### Violação de unicidade: case o nome da constraint, não só o código

O repositório traduz `23505` do Postgres para erro de domínio, mas **só quando a
`constraint` é a esperada**. A `users` já tem duas constraints únicas — o índice
de e-mail e a primary key —, e casar apenas o código transformaria uma colisão de
`id` num `409 EMAIL_ALREADY_IN_USE` sobre uma falha que é `500`.

O nome do índice é constante exportada do arquivo de schema, lida pelo
repositório. É a exceção à exceção de magic strings do `CLAUDE.md`: ela vale
enquanto o nome aparece uma vez só.

O erro do `pg` fica no `.cause`, não no topo — o Drizzle embrulha em
`DrizzleQueryError`. Por isso a checagem anda a cadeia de `cause`, e não olha a
`message`.

### Erro de driver não sai do `infra/`

> **Regra:** um repositório **nunca** relança o erro que o driver lhe deu.

O motivo é que esse objeto carrega segredo. A `.message` do `DrizzleQueryError`
**não** é o texto da query: é `Failed query: ${query}\nparams: ${params}` — o
texto **mais todo parâmetro vinculado**. Num INSERT em `users`, um desses
parâmetros é o hash de senha. Como a `stack` deriva da `message` e `params` é
propriedade própria enumerável, são **três** carregadores do mesmo segredo no
mesmo objeto.

```ts
} catch (error) {
  if (isEmailAlreadyInUse(error)) throw new EmailAlreadyInUseError()

  throw toPersistenceError(error)   // ← nunca `throw error`
}
```

`src/infra/database/driver-error.ts` faz a conversão. O que sobrevive é **lista
de permissão, não de proibição**: a `message` do erro do Postgres, o `code`, o
`constraint` e a `query` com marcadores. Copiar tudo menos `params` traria o
`detail` junto, e é nele que o Postgres escreve o valor conflitante —
`Key (email)=(joao@example.com) already exists.`. Com lista de permissão, campo
novo que o driver adicione amanhã não entra por acidente.

O `PersistenceError` resultante **não tem `cause`**, e isso é o ponto do tipo: o
`stdSerializers.err` do pino concatena a cadeia inteira de `cause` na `message`
e na `stack` do erro de topo, então guardar o original vazaria tudo de volta a
partir de uma posição aninhada.

**Por que prevenir na origem em vez de limpar no log.** Conter no logger exige
antecipar *toda* posição onde um erro pode se esconder — `cause`, os `errors[]`
de um `AggregateError`, qualquer chave própria com valor parecido com erro. O
pino caminha por todas; um sanitizador nosso caminharia pelas que a gente
lembrasse. Prevenir tem **um** lugar para acertar, e ele já existia: o `catch`
que traduz a violação de constraint.

O `error-serializer.ts` continua registrado no logger como **segunda camada**,
para o caso de um repositório que não siga a regra deixar um erro cru chegar ao
log no topo.

### Tempo: `timestamptz` sempre, e a perda de precisão na leitura

Toda coluna de tempo é `timestamp with time zone`. **Ele não guarda fuso** — o
nome engana. Guarda um instante absoluto; o fuso só participa em duas bordas:
converte na entrada, se o valor vier com offset, e renderiza na saída conforme o
`TimeZone` da sessão. O mesmo registro, lido em três sessões:

```
UTC                 2026-08-26 00:55:13.159767+00    epoch 1787705713.159767
America/Sao_Paulo   2026-08-25 21:55:13.159767-03    epoch 1787705713.159767
Asia/Tokyo          2026-08-26 09:55:13.159767+09    epoch 1787705713.159767
```

Três aparências, um instante. A aplicação é imune: o `pg` devolve um `Date` do
JS, que também é instante absoluto — verificado com o processo Node em
`America/Sao_Paulo` lendo o mesmo epoch.

O que **não** se usa é `timestamp` sem timezone: esse guarda o relógio de parede
literal, sem conversão. É de onde vêm os bugs de deploy multi-região — dois
servidores gravando "14:00" e nenhuma forma de saber qual.

> ⚠️ **Precisão se perde na leitura.** O Postgres guarda microssegundos; o `Date`
> do JS só tem milissegundos. Ler um valor gravado pelo `now()` do banco trunca:
> `…13.159767` vira `…13.159`.
>
> Irrelevante para `created_at`. Relevante para qualquer comparação exata de
> instantes onde um lado venha do banco e o outro do `IClock` — ver decisão 11.
> Quando o `IClock` for a fonte, tudo passa a ser gravado com precisão de ms de
> qualquer forma, e a assimetria sobra só nas linhas escritas pelo default.

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
(spec crua em `/docs/json`). Ali também é declarado
`components.securitySchemes.bearerAuth` (`http`, esquema `bearer`, formato
`JWT`) — os endpoints protegidos referenciam esse esquema por `security:
[{ bearerAuth: [] }]` em vez de repetir a definição em cada arquivo.

> **Só em `NODE_ENV=development`.** Nenhum ambiente deployado publica a
> superfície da API: fora de development as rotas nem existem, respondem 404.

Duas armadilhas de ordem, ambas silenciosas:

- **`registerOpenApi` tem que rodar antes das rotas.** O `@fastify/swagger`
  engancha no hook `onRoute`; rota registrada antes dele simplesmente não
  aparece na spec — sem erro, sem aviso.
- **`transform: jsonSchemaTransform` é obrigatório.** É ele que converte o Zod
  em JSON Schema. Sem ele a spec sai vazia.

### Todo endpoint declara todo status que ele mesmo produz

```ts
response: {
  [CREATED_STATUS]: createdSchema,
  [BAD_REQUEST_STATUS]: errorResponseSchema,   // validação do Zod
  [CONFLICT_STATUS]: errorResponseSchema,      // EmailAlreadyInUseError
},
```

O motivo é o cliente: num boilerplate cujo consumidor é app mobile, o OpenAPI é o
contrato de onde se gera código. Endpoint que documenta só o caminho feliz
obriga o cliente a descobrir os erros por tentativa.

**"Que ele mesmo produz" é o recorte, e ele importa.** Declara-se o que o handler
e o schema daquela rota podem gerar — `register.ts` declara `201`, `400` e `409`;
`health.ts` declara `200` e `503`; `refresh.ts`, `logout.ts` e `logout-all.ts`
declaram **503** porque abrem transação, e um deadlock que sobrevive ao retry do
runner sai como `TransactionConflictError`. **Não** se declara o que o framework produz em
qualquer rota: `500` do handler genérico e `415` de content-type errado são
universais, e repetir os dois em todo arquivo é ruído que ninguém mantém.

> **Declarar tem uma consequência que não é óbvia:** o `serializerCompiler` passa
> a **validar** o corpo daquele status contra o schema. Se o `error-handler.ts`
> um dia produzir uma forma que não bate, o cliente recebe **500** no lugar do
> status pretendido. Funciona hoje porque `errorResponseSchema` tem `details`
> opcional, e as duas formas que o handler emite — com e sem `details` — passam
> nas duas. Um campo novo obrigatório no envelope quebraria isso em silêncio, e
> o teste que pega é o que assere o **corpo**, não só o status.

> **Medida, não hipotética.** `z.iso.datetime()` rejeita um `Date`: devolver um
> campo de data cru onde o schema promete essa string responde **500**, sem nada
> no corpo apontando a causa — é exatamente a consequência acima, aplicada.

> **O type provider dá dente à regra, e isso foi verificado.** Sob o
> `ZodTypeProvider`, responder um status que o schema **não declara** é **erro de
> compilação**: `reply.status(204)` num endpoint que declara só `401` falha com
> *"Argument of type '204' is not assignable to parameter of type '401'"*. A
> regra desta seção deixou de depender só de revisão para o status do próprio
> handler.
>
> **Um 204 precisa de `z.null()` no schema e `.send(null)` no handler.**
> `.send()` sem argumento não compila (*"Expected 1 arguments, but got 0"*). O
> corpo sai com zero bytes e o documento publica a resposta **sem `content`**,
> que é a forma certa para um 204.

### Data em resposta: declare `z.date()`, não `z.iso.datetime()`

A saída de um schema de data é a mesma nas duas formas; o que muda é **quem
converte**.

| No schema | O handler entrega | Vai no corpo | Publica no OpenAPI |
|---|---|---|---|
| `z.date()` | `Date` | `"2026-08-28T00:38:13.576Z"` | `type: string, format: date-time` |
| `z.iso.datetime()` | `string` ISO | idem | idem **+ um `pattern` longo** |

O `serializerCompiler` aceita o `Date` e emite ISO sozinho — medido, inclusive
com campo anulável, e continua rejeitando tipo errado, então o schema segue sendo
guarda. O `pattern` extra não tem consumidor num schema de **resposta**: quem gera
cliente usa o `format`, e ninguém valida a resposta do servidor contra a regex.
Ele ganha o pão em schema de **request** — é o caso do `PASSWORD_POLICY_PATTERN`
no register.

**O que isso decide não é formatação, é fronteira.** Com `z.iso.datetime()`, todo
handler chama `.toISOString()`, e para isso precisa conhecer os tipos internos do
domínio. Com `z.date()`, o use case entrega a forma que o contrato publica e o
endpoint só escolhe o status:

```ts
const profile = await container.getUserProfile.execute(getPrincipal(request).id)

return reply.status(OK_STATUS).send(profile)
```

**A regra que sai daí, e vale para o próximo use case:** *comando devolve recibo,
consulta devolve read model.* `registerUser` e `loginUser` mudam estado e
devolvem o mínimo (`{ id }`, `{ accessToken }`); `getUserProfile` não muda nada e
devolve `UserProfileResult` — plano, com o value object já desembrulhado e as
datas ainda como `Date`.

Datas ficam `Date` de propósito: formatar é trabalho do transporte, e devolver
ISO da camada pura faria ela servir HTTP especificamente, deixando os entrypoints
de worker e cron (decisão 10) fazendo parse de volta.

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
// ConflictError, UnauthorizedError, ForbiddenError, ValidationError,
// BusinessRuleError, TransientError
```

O `code` é **declarado**, nunca derivado do nome da classe. Derivar faria o nome
da classe virar contrato público em silêncio: um PR de renome passaria no
typecheck, no lint e em todo teste, e quebraria o `switch (error.code)` de todo
app em produção sem deixar rastro no diff.

### O mapa não cresce

`infra/http/errors/error-handler.ts` é o **único** lugar que traduz erro em status HTTP.
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
| `TransientError` | 503 |

As sete são **irmãs** — todas estendem `AppError` direto. Se alguma passar a
estender outra, o mapa começa a depender da ordem das linhas.

`TransientError` é a única que acrescenta um header: o `503` sai com
`Retry-After`. Sem ele o cliente sabe que pode repetir mas não quando, e um laço
apertado contra um banco já em contenção é pior que não repetir. Nenhuma das
outras leva o header — repetir um 409 não o resolve.

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

### Bibliotecas que falham em silêncio

Três armadilhas que já custaram tempo uma vez cada. O que as une não é a
biblioteca, é o modo de falha: **o código parece certo, compila ou passa, e faz
outra coisa.**

> **O `.default()` do Zod 4 curto-circuita — ele não parseia o valor.** Num
> schema cuja entrada é string e a saída número, `.default('5000')` devolve a
> **string** `"5000"`, não `5000`. O default é do tipo de **saída**, então
> escreva `.default(5000)`. Descoberto porque um teste comparava o objeto de
> config inteiro com `toEqual`; com asserção campo a campo teria passado, e o
> pool receberia uma string onde espera número.

> **`.pipe(z.coerce.number())` depois de `z.string()` não compila — e o estrago
> não fica no lugar do erro.** O schema coagido declara entrada `unknown`, que
> não encaixa a jusante de um schema de string. O `tsc` reporta a linha do
> `pipe`, mas o efeito é o tipo inferido do objeto **inteiro** degradar para
> `any`, e aí todo consumidor dele para de ser verificado. Use
> `.transform(Number).pipe(z.number())`. Vale a lição geral: um erro dentro de um
> `z.object` grande apaga a tipagem de tudo que depende dele.

> **`SET LOCAL` não aceita parâmetro ligado.** `SET LOCAL lock_timeout = $1` é
> recusado pelo Postgres com `42601 syntax error at or near "$1"` — `SET` não é
> uma query parametrizável. Tem de ir por `sql.raw`, e **por isso o valor nunca
> pode vir de request**. Verificado também que ele reverte no `COMMIT`, então é
> seguro num pool: dentro da transação vale o valor local, depois volta o da
> conexão.

> **`clearCookie` não herda os atributos de `setCookie`.** Passando só
> `{ path }`, o `Set-Cookie` de expiração sai com `SameSite=Lax`, **sem
> `HttpOnly` e sem `Secure`**. A deleção funciona assim mesmo — o browser casa
> por nome, domínio e path —, mas o cookie emitido é mais fraco que o original.
> Passe o conjunto completo de atributos.

> **Cookie `Secure` sobre `http://localhost` é recusado pelo Safari.** Medido em
> 2026-09-01: Chrome e Firefox aceitam, o WebKit não — em macOS e em iOS. O
> browser que recusa **não guarda o cookie e não avisa**, nem erro nem console,
> e o refresh seguinte responde 401 como se nunca tivesse havido login.
> Consequência concreta: **o modo cookie não pode ser exercitado pelo `/docs` no
> Safari**; use um browser Chromium, ou termine TLS na frente da API. Testar de
> aparelho real por IP de LAN falha igual em **todo** browser, porque endereço
> de LAN cru nunca é origem confiável.
>
> A correção óbvia — condicionar o `Secure` a `NODE_ENV` — é pior: essa variável
> tem `.default('development')` no `env.ts`, então qualquer deploy que esquecesse
> de defini-la mandaria o cookie **sem `Secure`**, em silêncio. Falha aberta em
> produção é pior que caça ao fantasma num laptop.

> **`exactOptionalPropertyTypes` transforma um parâmetro opcional repassado em
> erro a três linhas de distância.** Encaminhar `cookies?: Record<string,string>`
> direto para as opções do `app.inject` passa um `undefined` explícito, que é
> inválido para propriedade opcional; o `inject` então falha a resolução de
> overload e reporta o retorno como `void & Promise<Response> & Chain`, de modo
> que o erro aparece como *"statusCode does not exist"*. Espalhe
> condicionalmente em vez de repassar.

> **`request.ip` não é um endereço IP.** Medido no Fastify 5.12.1: quando o peer
> é confiado, ele devolve **o último token do `X-Forwarded-For` sem validação
> nenhuma** — `naoehip`, `1.2.3.4a`, `999.999.999.999`,
> `<script>alert(1)</script>` e uma string de 200 caracteres saíram todas
> intactas. `typeof` é sempre `string`, nada lança, e no laptop o valor parece
> perfeito. Quem usar isso como chave, índice ou campo persistido está deixando
> o atacante escolher o conteúdo **e o tamanho**. Passe por
> `infra/http/client-ip.ts`, que valida e normaliza — e note que normalizar não
> é opcional: substituir o `keyGenerator` do `@fastify/rate-limit` descarta o
> agrupamento de IPv6 por /64 que ele aplicaria, e sem isso um único assinante
> tem 2⁶⁴ endereços, logo baldes ilimitados.

> **`trustProxy` com número é inoperante — e parece configurado.** Medido no
> Fastify 5.12.1: `trustProxy: 1` constrói sem erro e **nunca confia em
> ninguém**, porque o `lib/request.js` devolve `() => false` para qualquer
> número (*"hop-count-only trust cannot validate the immediate peer"*).
> `request.ip` fica preso no `remoteAddress`, e atrás de um load balancer isso
> significa que todo cliente compartilha um endereço — um limite por IP botaria
> o mundo inteiro num balde só. É justamente o valor que todo tutorial mostra.
> Por isso `TRUST_PROXY` **recusa número no boot** e só aceita lista de redes.
>
> No mesmo assunto: uma lista com CIDR inválido morre na **construção** da
> instância — inclusive quando só um item da lista é inválido, não há aceitação
> parcial —, mas como um `TypeError` **cru** do `@fastify/proxy-addr`, com
> `message: "invalid IP address: <token>"` e **`code: undefined`**. Não é
> `FST_*` e não sai no formato de erro de env do projeto: se o boot morrer com
> um `TypeError` sem contexto nenhum, é isto.

> **`loggerInstance` do Fastify especializa o genérico da instância.** Passar um
> `pino.Logger` faz o `FastifyInstance` devolvido carregar aquele tipo de logger,
> e ele deixa de ser atribuível ao `FastifyInstance` que a função declara
> devolver. A correção não é cast: anote o valor como `FastifyBaseLogger` antes
> de passá-lo, e o genérico fica fixo.

---

## 12. Decisões travadas

**TypeScript pinado em `7.0.2` exato, sem caret.** O TS 7 é o port em Go e mudou o
`exports` do pacote: a raiz passou a exportar só a versão, e a API do compilador
foi para `./unstable/*`. Consequência prática — **`typescript-eslint` e
`dependency-cruiser` não funcionam com TS 7**, porque ambos consomem a API antiga.
O `dependency-cruiser` é o pior dos dois: ele emite *aviso*, não erro, e sai com
**exit 0** e `0 modules cruised`, ou seja, CI verde sem enforçar nada.

**A terceira consequência é o seu editor, e ela tem saída.** O TS 7 também não
entrega `tsserver.js` — o mecanismo que o `typescript.tsdk` do VS Code
classicamente aponta. O pacote `typescript` virou um **localizador**: `lib/` tem
só `tsc.js`, `version.cjs` e `getExePath.js`, e o compilador de verdade é um
binário Go de ~24 MB entregue por plataforma em `optionalDependencies`
(`@typescript/typescript-linux-x64` e irmãos).

Isso **não** significa que o editor não possa usá-lo. O próprio `getExePath.js`
do pacote carrega a nota:

```js
// NOTE: Keep VS Code extension's resolveTsdkPathToExe in sync with this function.
```

Ou seja: a extensão TypeScript do VS Code resolve o tsdk **para o executável**, em
vez de para um `tsserver.js`. Numa extensão nova o bastante, editor e CI rodam o
mesmo compilador. Numa mais antiga, o editor cai no TypeScript embutido dele
(linha 5.x) e passa a discordar do CI **nos dois sentidos** — acusando o que o
`tsc` aceita e deixando passar o que o `tsc` pega.

Como saber em qual caso você está: `TypeScript: Select TypeScript Version` na
paleta de comandos mostra o que está ativo e oferece *Use Workspace Version*. Se
a do workspace não pegar, `"typescript.tsdk": "node_modules/typescript/lib"` em
`.vscode/settings.json` e reiniciar o TS server; se ainda reportar 5.x, a
extensão é antiga demais.

> **A regra que vale de qualquer forma:** `pnpm typecheck` é a autoridade, porque
> é ele que o CI roda, com a versão pinada. Divergiu do editor, o editor está
> errado. E antes de investigar uma divergência, reinicie o TS server — ele
> guarda estado velho e a maioria dos "erros fantasma" é isso.

**Biome no lugar de ESLint + Prettier.** Decorre do primeiro parágrafo: o Biome é
um binário Rust com **zero dependências JS**, com parser próprio — a versão do
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

verificação de e-mail · troca de senha · módulos de negócio · entrypoints
`worker.ts` e `cron.ts` · poda de `refresh_tokens` expirados · rate limiting ·
CORS · regra de fronteira no lint · Docker

> **Corrigido em 2026-09-01:** esta lista dizia que o Unit of Work não existia,
> e a fatia 4 o construiu em 2026-08-29. Ele saiu daqui.

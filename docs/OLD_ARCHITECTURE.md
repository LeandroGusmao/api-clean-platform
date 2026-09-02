# 🏛️ Arquitetura

Referência normativa desta base. Descreve **o que a arquitetura é** e **quais
regras valem**. O raciocínio de cada escolha, as alternativas avaliadas e o
histórico ficam em [`docs/DECISIONS.md`](DECISIONS.md) — as marcas
`(decisão NN)` apontam para lá.

Onde algo ainda **não está decidido**, o documento diz isso explicitamente em vez
de legislar. Procure por ⚠️ **EM ABERTO**.

**Stack:** Node.js LTS · TypeScript ESM · Fastify 5 · PostgreSQL · Drizzle ·
Zod + `fastify-type-provider-zod` · pino · argon2id · Vitest · pnpm ·
`dependency-cruiser`

> **Versões travadas:** `drizzle-orm` e `drizzle-kit` pinados em **`1.0.0-rc.4`
> exato, sem caret**, sempre em lockstep — RC não respeita semver. *(decisão 07)*

---

## 1. Princípio central

O sistema se organiza em **módulos verticais**. Cada módulo é uma subárvore
fechada com suas regras de negócio e seus adaptadores.

Dentro do módulo vale **uma única fronteira**:

> **Código puro nunca depende de código que toca o mundo externo.**

"Mundo externo" é banco, HTTP, rede, sistema de arquivos, variável de ambiente,
**relógio** e **aleatoriedade**. Tudo isso vive atrás de contrato e é implementado
em `infra/`. O resto é puro e não sabe que `infra/` existe.

É isso que torna a regra de negócio testável sem banco, sem servidor e sem
congelar o tempo por gambiarra — e o que permite trocar Drizzle, Fastify ou o
algoritmo de hash sem tocar em `use-cases/`.

---

## 2. Estrutura de pastas

```text
src/
├── modules/                              # um diretório por módulo de negócio
│   └── auth/
│       │  ── PURO ───────────────────────────────────────────
│       ├── entities/
│       │   └── user.ts
│       ├── value-objects/
│       │   └── email.ts
│       ├── repositories/                 # SÓ contratos
│       │   ├── users-repository.ts
│       │   ├── refresh-tokens-repository.ts
│       │   └── unit-of-work.ts
│       ├── providers/                    # SÓ contratos
│       │   ├── hash-provider.ts
│       │   └── token-signer.ts
│       ├── use-cases/
│       │   ├── authenticate-user.ts
│       │   └── authenticate-user.spec.ts # teste unitário, colocado
│       ├── dtos/
│       ├── errors/
│       │   └── invalid-credentials-error.ts
│       ├── config.ts                     # schema Zod das env vars DESTE módulo
│       ├── container.ts                  # factory do grafo DESTE módulo
│       │
│       │  ── INFRA ──────────────────────────────────────────
│       └── infra/
│           ├── drizzle/
│           │   ├── schema.ts
│           │   ├── user-mapper.ts
│           │   ├── drizzle-users-repository.ts
│           │   └── drizzle-unit-of-work.ts
│           ├── in-memory/
│           │   └── in-memory-users-repository.ts
│           ├── providers/
│           │   ├── argon2-hash-provider.ts
│           │   └── jwt-token-signer.ts
│           └── http/
│               ├── endpoints/            # 1 arquivo = schemas + handler + rota
│               ├── middlewares/
│               │   └── ensure-authenticated.ts
│               └── routes.ts             # agregador fino do módulo
│
├── infra/                                # infra GLOBAL, sem dono de módulo
│   ├── config/env.ts                     # merge dos schemas + validação no boot
│   ├── database/client.ts                # conexão Postgres, instância Drizzle
│   ├── http/
│   │   ├── server.ts                     # instância Fastify SEM rotas
│   │   └── error-handler.ts              # ÚNICO lugar que mapeia erro → status
│   ├── observability/
│   │   ├── context.ts                    # AsyncLocalStorage: traceId
│   │   └── logger.ts                     # pino, com redação de segredo
│   └── providers/
│       ├── system-clock.ts
│       └── crypto-token-generator.ts
│
├── shared/                               # transversal, sem dono
│   ├── errors/
│   │   ├── app-error.ts
│   │   └── taxonomy.ts
│   └── providers/
│       ├── clock.ts                      # contrato IClock
│       └── token-generator.ts            # contrato ITokenGenerator
│
└── main/                                 # entrypoints + composition root
    ├── container.ts
    ├── http.ts                           # monta o container e REGISTRA as rotas
    ├── worker.ts
    └── cron.ts

tests/integration/
drizzle/                                  # migrations, forward-only
drizzle.config.ts
.dependency-cruiser.cjs                   # regra de fronteira
```

**Por que as camadas não viram pastas.** `entities/` e `use-cases/` **já dizem**
qual camada são; envolvê-las num `domain/` e num `application/` repetiria o nome e
aumentaria a profundidade do caminho diário. *(decisões 01 e 02)*

---

## 3. A regra de dependência

Contrato vive no puro; implementação vive em `infra/`. O use case depende do
contrato e **nunca** da implementação:

```ts
// modules/auth/repositories/users-repository.ts             (PURO)
export interface IUsersRepository {
  findByEmail(email: string): Promise<User | null>
  save(user: User): Promise<void>
}

// modules/auth/infra/drizzle/drizzle-users-repository.ts     (INFRA)
export class DrizzleUsersRepository implements IUsersRepository { /* ... */ }

// modules/auth/infra/in-memory/in-memory-users-repository.ts (INFRA)
export class InMemoryUsersRepository implements IUsersRepository { /* ... */ }
```

É essa simetria que permite ao teste unitário rodar em milissegundos.

### A fronteira, por tipo de elemento

Uma glob só não resolve: deixa o `src/infra/` **global** de fora e proíbe o
composition root e os testes, que precisam alcançar o concreto. São cinco tipos,
**avaliados nesta ordem** — `test` primeiro. *(decisão 02)*

| Ordem | Elemento | Padrão | Pode importar |
|---|---|---|---|
| 1 | `test` | `**/*.spec.ts` · `tests/**` | tudo |
| 2 | `composition` | `src/modules/*/container.ts` · `src/main/**` | tudo |
| 3 | `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · `module-infra` **do próprio módulo** |
| 4 | `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| 5 | `pure` | `src/modules/*/{entities,value-objects,repositories,providers,use-cases,dtos,errors}/**` · `src/modules/*/config.ts` · `src/shared/**` | só `pure` |

> **A ordem não é decorativa.** O padrão de `pure` casa com os `*.spec.ts`
> colocados — sem `test` sendo avaliado antes, o teste unitário é classificado
> como puro e acusado por importar o repositório in-memory, quebrando o CI em todo
> módulo. Configure `test` como exclusão explícita do padrão `pure`.

Três consequências que costumam passar batido:

- **`pure` não alcança o `src/infra/` global.** É o que impede um use case de
  importar o logger ou o `env` já parseado — proibições das decisões 15 e 14 que
  R6 sozinha não cobre, porque ela fala de `process.env`, não de quem o lê.
- **`module-infra` não alcança o `infra/` de outro módulo.** É a metade de R5 que
  não se resolve com contrato.
- **`composition` e `test` são exceções deliberadas, não brechas.** O composition
  root existe para conhecer o concreto (§7) e o teste unitário precisa do
  repositório in-memory (§14).

> ⚠️ **EM ABERTO — o alcance de `pure → pure` entre módulos.** A §6.1 **exige**
> que `modules/orders/use-cases/` importe `IProductsRepository`, então cruzar
> módulos no puro é permitido. Mas sem qualificar *quais* subpastas são
> alcançáveis de fora, `modules/orders/entities/` também pode importar
> `modules/auth/entities/User` e se acoplar ao modelo interno de outro módulo —
> que é o que R5 existe para evitar. A intenção é liberar só `repositories/`,
> `providers/`, `dtos/` e `errors/`, mas isso **é a decisão de superfície pública,
> ainda em aberto** (§6).

### Como as regras são enforçadas

| Regra | Mecanismo |
|---|---|
| A tabela de fronteira acima (decisão 02, R5) | **`dependency-cruiser`** |
| Só `env.ts` lê `process.env` (R6) | ESLint — `no-restricted-syntax` |
| Puro não gera valor não determinístico (R7) | ESLint — `no-restricted-syntax` / `no-restricted-globals` |

> **Por que não `eslint-plugin-boundaries`.** Ele **ignora silenciosamente todo
> import que o resolver não resolve**, e nenhum resolver de ESLint testado entende
> o campo `imports` do package.json. Como a §15 estabelece que todos os imports
> entre diretórios usam `#`, o lint passaria verde sem enxergar nada. O
> `dependency-cruiser` usa `enhanced-resolve` e enxerga. *(decisão 18)*

> ⚠️ **EM ABERTO:** a regra está **especificada**, mas a configuração ainda não
> foi escrita — até lá, nada acima é garantido.
>
> **Critério de aceite obrigatório:** um fixture por linha da tabela, escrito
> **com especificador `#`**, que precisa **falhar** a verificação. Sem esse
> fixture, a config pode parecer correta e não enforçar nada — foi exatamente essa
> armadilha que derrubou a ferramenta original.

---

## 4. Anatomia de um módulo

| Diretório | Natureza | Responsabilidade |
|---|---|---|
| `entities/` | puro | Estado e comportamento de domínio |
| `value-objects/` | puro | Valor com regra própria (`Email`, `Money`) |
| `repositories/` | puro | **Contratos** de persistência e o Unit of Work |
| `providers/` | puro | **Contratos** de serviço externo: hash, assinatura de token |
| `use-cases/` | puro | Orquestra a regra; uma operação por arquivo |
| `dtos/` | puro | Entrada e saída do use case |
| `errors/` | puro | Erros do módulo, estendendo a taxonomia |
| `config.ts` | puro | Schema Zod das env vars do módulo |
| `container.ts` | composição | Monta o grafo do módulo |
| `infra/drizzle/` | infra | Schema, mapper, repositórios e Unit of Work concretos |
| `infra/in-memory/` | infra | Repositórios em memória, para teste unitário |
| `infra/providers/` | infra | Implementações dos contratos de provider |
| `infra/http/` | infra | Endpoints, middlewares e rotas |

Além da fronteira da §3, não há restrição declarada **dentro** do puro de um
módulo — esses diretórios compõem livremente entre si.

**Nomenclatura:** `kebab-case.ts`. A implementação concreta leva o prefixo da
tecnologia (`drizzle-users-repository.ts`); o contrato não.

---

## 5. Fluxo de uma requisição

Ciclo de vida de `POST /auth/sessions`:

```
1. main/http.ts
   Valida env, abre o banco, monta o container.
   Pede a instância Fastify a infra/http/server.ts e REGISTRA os plugins
   de módulo, cada um com seu prefixo e SUA FATIA do container.

2. modules/auth/infra/http/routes.ts
   Agrega os endpoints do módulo e repassa a fatia recebida.

3. modules/auth/infra/http/endpoints/authenticate.ts
   Valida corpo e resposta por schema Zod.
   Chama o use case da fatia do container.
   Traduz o retorno em resposta HTTP. NÃO contém regra de negócio.

4. modules/auth/use-cases/authenticate-user.ts
   Busca o usuário por IUsersRepository.
   Compara o hash por IHashProvider — SEMPRE, inclusive quando o usuário
     não existe (ver abaixo).
   Calcula exp por IClock + cfg.ACCESS_TOKEN_TTL e assina por ITokenSigner.
   Gera o refresh opaco por ITokenGenerator e persiste dentro de uow.run.
   Ou lança InvalidCredentialsError.
   Não conhece HTTP, não conhece Drizzle, não loga, não chama new Date().

5. modules/auth/infra/drizzle/drizzle-users-repository.ts
   Executa o SQL e converte a row em entidade pelo mapper.

   Se (3), (4) ou (5) lançarem:
6. infra/http/error-handler.ts
   Mapeia para status e monta o corpo com o traceId.
```

> **Passo 4 — comparação obrigatória mesmo sem usuário.** Se o use case retornar
> cedo quando o e-mail não existe, e-mail inexistente responde em ~1 ms enquanto
> e-mail existente paga o argon2id (~50–100 ms). Isso é um **oráculo de
> enumeração de usuários** trivialmente mensurável — e o rate limiting ainda está
> em aberto (§13). Quando o usuário não é encontrado, compare contra um hash dummy
> fixo antes de lançar.

> **Passo 4 — quem carimba `exp`.** É o use case, via `IClock` +
> `ACCESS_TOKEN_TTL`, passando `exp` no payload. Deixar a biblioteca de JWT
> carimbar com o relógio dela **anula R7**: o teste unitário perde o controle da
> expiração.

O handler HTTP é **um tradutor**. Qualquer `if` de regra de negócio nele está no
lugar errado.

---

## 6. Comunicação entre módulos

> **Regra de ouro:** a comunicação entre módulos acontece na camada de use case ou
> através de contratos. **Nunca** invoque o handler HTTP de outro módulo, nem faça
> chamada HTTP interna ao próprio servidor. *(R5)*

### 6.1 Injetar o contrato do módulo alvo — recomendado, cobre a maioria

```ts
// modules/orders/use-cases/create-order.ts
export class CreateOrderUseCase {
  constructor(
    private ordersRepository:   IOrdersRepository,
    private productsRepository: IProductsRepository, // contrato do outro módulo
  ) {}

  async execute({ productId, quantity }: CreateOrderDTO) {
    const product = await this.productsRepository.findById(productId)
    if (!product) throw new ProductNotFoundError()
    if (product.stock < quantity) throw new InsufficientStockError()

    const order = Order.create({ productId, quantity, price: product.price })
    await this.ordersRepository.save(order)
    return order
  }
}
```

### 6.2 Reusar o use case do módulo alvo — quando há efeito colateral

Se a interação envolve regra complexa ou efeito colateral (reservar estoque,
aplicar cupom), injete e execute o use case, não o repositório.

### 6.3 Eventos de domínio — desacoplamento completo

Para preparar extração futura em serviço separado: o chamador persiste em
`PENDING` e despacha o evento; o módulo alvo reage e despacha o resultado; o
chamador atualiza para `CONFIRMED` ou `CANCELLED`.

### Antipadrões

- ❌ **Chamada HTTP interna** — `axios.get('/api/products/123')` dentro do mesmo
  processo. Latência, overhead e ponto de falha sem ganho algum.
- ❌ **Reusar handler HTTP** — chamar o handler de outro módulo dentro de um
  fluxo. Handler só traduz HTTP.
- ❌ **Importar `infra/` de outro módulo** — pegar `DrizzleUsersRepository` em vez
  do contrato. Coberto pela linha `module-infra` da §3.
- ❌ **Alcançar o container de outro módulo** — impossível por construção: o
  plugin recebe só a fatia dele (§7).

> ⚠️ **EM ABERTO — a superfície pública do módulo.** A regra da §3 barra um caso
> legítimo: `ensure-authenticated` pertence ao `auth` e **todos os módulos
> consomem**. Ou seja, `auth` tem superfície pública, e ela não foi definida —
> barrel `index.ts`? pasta `public/`? caminho permitido na config?
>
> A mesma decisão resolve o alcance de `pure → pure` entre módulos (§3).
>
> Até fechar, `ensure-authenticated` é **exceção declarada explicitamente na
> configuração** — não uma violação tolerada em silêncio.

---

## 7. Composição de dependências

Não há container mágico, decorator nem `reflect-metadata`. O grafo é montado à
mão, com tipo inferido. *(decisão 08)*

```ts
// modules/auth/container.ts
export function makeAuthContainer(
  db: Database, cfg: AuthConfig, clock: IClock, tokens: ITokenGenerator,
) {
  const usersRepository = new DrizzleUsersRepository(db)
  const unitOfWork      = new DrizzleAuthUnitOfWork(db)
  const hashProvider    = new Argon2HashProvider()
  const tokenSigner     = new JwtTokenSigner(cfg.JWT_SECRET)

  return {
    // escreve em 2 repositórios -> recebe o UoW (§8)
    authenticateUser: new AuthenticateUserUseCase(
      usersRepository, unitOfWork, hashProvider, tokenSigner, tokens, clock, cfg,
    ),
    refreshSession: new RefreshSessionUseCase(unitOfWork, tokenSigner, tokens, clock, cfg),
    // escreve em 1 repositório -> recebe o repositório direto
    registerUser: new RegisterUserUseCase(usersRepository, hashProvider, clock),
  }
}
export type AuthContainer = ReturnType<typeof makeAuthContainer>

// modules/auth/config.ts — a fatia tipada, extraída do Env global
export type AuthConfig = z.infer<typeof authEnvSchema>
export const authConfigOf = (env: Env): AuthConfig => authEnvSchema.parse(env)

// main/container.ts
export function makeContainer(db: Database, env: Env) {
  const clock  = new SystemClock()
  const tokens = new CryptoTokenGenerator()
  return { auth: makeAuthContainer(db, authConfigOf(env), clock, tokens) }
}
export type Container = ReturnType<typeof makeContainer>
```

**Regras:**

- Todo `new` de implementação concreta acontece em `container.ts`. Endpoint e use
  case **nunca** instanciam infra.
- Objeto sem estado (repositório, provider) é singleton do container.
- Os três entrypoints de `main/` usam **o mesmo** `makeContainer`. É por isso que
  a DI não pode depender do Fastify. *(decisão 10)*
- **O módulo recebe a fatia dele da config**, não o `Env` global.

### Como o container chega ao handler

Por **opção de registro do plugin**, com a fatia do módulo. *(decisão 23)*

```ts
// main/http.ts
await app.register(authRoutes, { prefix: '/auth', container: container.auth })
```

```ts
// modules/auth/infra/http/routes.ts
export const authRoutes: FastifyPluginAsync<{ container: AuthContainer }> =
  async (app, opts) => {
    await app.register(authenticateRoute, { container: opts.container })
    await app.register(registerRoute,     { container: opts.container })
  }
```

O compilador barra sozinho o acesso cruzado: dentro de `modules/auth`, o tipo
recebido é `AuthContainer` e `container.products` **não existe**.

> **Por que não `app.decorate('container', container)`.** Exigiria
> `declare module 'fastify'`, que é global e ambiente: todo endpoint de todo
> módulo passaria a enxergar `app.container.<qualquer módulo>` com tipagem
> completa. E isso é **acesso a propriedade, não import** — nenhum lint de
> fronteira pega. R5 seria violável sem deixar rastro.

---

## 8. Persistência

**Drizzle**, com o schema declarado **por módulo** e agregado por glob no
`drizzle.config.ts`. *(decisão 06)*

```ts
// modules/auth/infra/drizzle/schema.ts
export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),   // nome diz o que guarda
  createdAt:    timestamp('created_at').notNull().defaultNow(),
})
```

### O tipo `Database`

```ts
// infra/database/client.ts
export type Database = NodePgDatabase<Record<string, never>>
                     | PgTransaction<any, any, any>   // o que o callback recebe
```

> O objeto que o Drizzle entrega ao callback de `transaction` **não tem o mesmo
> tipo** do handle de topo. Os repositórios precisam aceitar a união, senão o
> Unit of Work não compila.

### Mappers

O repositório devolve **entidade de domínio**, nunca a row. *(decisão 20)*

```ts
// modules/auth/infra/drizzle/user-mapper.ts
export const toDomainUser      = (row: UserRow): User      => { /* ... */ }
export const toPersistenceUser = (user: User):  NewUserRow => { /* ... */ }
```

### Atomicidade — Unit of Work

Use case que escreve em **mais de um repositório** recebe um Unit of Work.
*(decisão 22)*

```ts
// modules/auth/repositories/unit-of-work.ts  (PURO — contrato)
export interface AuthRepos {
  users:         IUsersRepository
  refreshTokens: IRefreshTokensRepository
}
export interface IAuthUnitOfWork {
  run<T>(fn: (repos: AuthRepos) => Promise<T>): Promise<T>
}

// uso: a transação está VISÍVEL na assinatura
async execute(dto: RefreshTokenDTO) {
  return this.uow.run(async ({ refreshTokens }) => {
    const current = await refreshTokens.findActiveForUpdate(hash)  // trava a linha
    await refreshTokens.revoke(current)
    await refreshTokens.save(next)
  })
}
```

> Use case que escreve num repositório só continua recebendo o repositório direto
> — injetar UoW em tudo faria o caso simples pagar o custo do complexo.

### Migrations

Geradas pelo `drizzle-kit`, versionadas em `drizzle/`, **forward-only**. *(R4)*
Toda migration precisa ser compatível com a versão **anterior** do código
(expand/contract), porque é aplicada **antes** de a nova versão subir.

> **Migration nunca roda no boot.** Com múltiplas instâncias subindo em paralelo
> isso cria corrida. É passo separado do pipeline. *(decisão 17)*

---

## 9. Camada HTTP

**Fastify**, com cada módulo exportando um plugin. *(decisão 04)*

Um endpoint é **um arquivo**: schema de entrada, **schema de resposta**, handler e
rota. *(decisão 03)*

```ts
// modules/auth/infra/http/endpoints/authenticate.ts
const bodySchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8),
})

// schema de resposta é OBRIGATÓRIO — ver abaixo
const okSchema = z.object({ accessToken: z.string() })

export const authenticateRoute: FastifyPluginAsync<{ container: AuthContainer }> =
  async (app, { container }) => {
    app.withTypeProvider<ZodTypeProvider>().post(
      '/sessions',
      { schema: { body: bodySchema, response: { 200: okSchema } } },
      async (req, reply) => {
        const { email, password } = req.body            // tipado pelo schema
        const result = await container.authenticateUser.execute({ email, password })
        return reply.status(200).send(result)
      },
    )
  }
```

> **O schema de resposta não é opcional.** Sem ele, `reply.send(entidade)` faz
> `JSON.stringify` sem filtro — e a entidade `User` carrega `passwordHash`. Um
> `register` que devolva a entidade **vaza o hash da senha**. Além disso, é o
> schema de resposta que ativa a serialização rápida do Fastify, citada na decisão
> 04 como razão de escolhê-lo.

> **`fastify-type-provider-zod` é obrigatório.** O Fastify espera JSON Schema; sem
> `setValidatorCompiler` / `setSerializerCompiler` registrados em
> `infra/http/server.ts`, passar um schema Zod cru **falha em runtime**.

**O prefixo é aplicado no registro, em `main/http.ts`** — `routes.ts` não o
declara. Isso importa: o cookie de refresh está preso em `Path=/auth/refresh`
(§13), então prefixo divergente quebra o refresh **só no cliente web**, em
silêncio.

**O endpoint de refresh aceita corpo ausente.** O web manda o token por cookie e
não envia corpo; o mobile manda no corpo. Um schema de body obrigatório rejeitaria
a requisição web com 400 antes do handler. O handler lê o cookie e, na ausência
dele, o corpo.

Não existe sufixo `.controller`: com a rota no mesmo arquivo, o arquivo é o
adaptador HTTP inteiro.

**Divisão de responsabilidade:** `infra/http/server.ts` constrói e configura uma
instância Fastify **sem rotas** — logger, compilers do type provider, error
handler, hooks — e a devolve. Quem registra os plugins de módulo e seus prefixos é
`main/http.ts`, que é `composition` e por isso pode alcançar `module-infra` (§3).

---

## 10. Erros

### Taxonomia

Os erros de domínio estendem classes **semânticas**, não protocolares. *(decisão 13)*

```ts
// shared/errors/app-error.ts
export abstract class AppError extends Error {
  abstract readonly code: string        // obriga toda subclasse a declarar
}

// shared/errors/taxonomy.ts — PURO, nenhuma menção a HTTP
export abstract class NotFoundError     extends AppError {}
export abstract class ConflictError     extends AppError {}
export abstract class UnauthorizedError extends AppError {}  // não autenticado
export abstract class ForbiddenError    extends AppError {}  // sem permissão
export abstract class ValidationError   extends AppError {}  // validação de DOMÍNIO
export abstract class BusinessRuleError extends AppError {}

// modules/auth/errors/invalid-credentials-error.ts
export class InvalidCredentialsError extends UnauthorizedError {
  readonly code = 'INVALID_CREDENTIALS'
  constructor() { super('Credenciais inválidas') }
}
```

### Mapeamento

`infra/http/error-handler.ts` é o **único** lugar que mapeia **erro** para status —
endpoint de sucesso escolhe o próprio status normalmente.

```ts
app.setErrorHandler((err, req, reply) => {
  // 1º: falha de schema do Fastify NÃO é da taxonomia
  if (hasZodFastifySchemaValidationErrors(err)) return reply.status(400).send(...)
  // 2º: a taxonomia
  if (err instanceof NotFoundError) return reply.status(404).send(...)
  // ...
})
```

| Origem | Status |
|---|---|
| `FST_ERR_VALIDATION` (schema do Fastify) | 400 · `VALIDATION_ERROR` |
| `ValidationError` (domínio) | 400 |
| `UnauthorizedError` | 401 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `BusinessRuleError` | 422 |
| qualquer outro | 500 |

> ⚠️ **A falha de schema tem que ser tratada ANTES da cadeia de `instanceof`.**
> Ela chega como `Error` com `code: 'FST_ERR_VALIDATION'` — **não** é instância de
> `ValidationError`, e nem poderia ser: a taxonomia é abstrata e mora na camada
> pura. Sem esse tratamento, **todo payload inválido responderia 500**.

**Tradução normativa dos códigos do Zod** — eles **não** são os do contrato:

| `issue.code` do Zod | `code` do contrato |
|---|---|
| `invalid_format` | `INVALID_FORMAT` |
| `too_small` | `TOO_SHORT` |
| `too_big` | `TOO_LONG` |
| `invalid_type` | `INVALID_TYPE` |
| demais | `INVALID_VALUE` |

Sem essa tabela, cada app derivado publica um contrato diferente.

**Erro inesperado** vira 500 com corpo genérico. Nada do interno vaza: sem stack,
sem mensagem de driver. O log registra tudo, correlacionado pelo `traceId`.

### Formato da resposta

```jsonc
{ "error": { "code": "INVALID_CREDENTIALS", "message": "Credenciais inválidas",
             "traceId": "01JXYZ..." } }

{ "error": { "code": "VALIDATION_ERROR", "message": "Payload inválido",
             "details": [ { "field": "email", "code": "INVALID_FORMAT" } ],
             "traceId": "01JXYZ..." } }
```

> **`code` é contrato público; `message` não é.** O cliente ramifica pelo `code` e
> o usa como chave de i18n. A `message` serve para log e depuração — **não deve
> ser exibida crua** num app traduzido. Mudar `code` ou o formato exige release
> coordenada dos apps que já consomem.

---

## 11. Configuração

Cada módulo declara o schema das **suas** variáveis; o boot faz merge e valida
tudo de uma vez. *(decisão 14)*

```ts
// modules/auth/config.ts
export const authEnvSchema = z.object({
  JWT_SECRET:        z.string().min(32),
  ACCESS_TOKEN_TTL:  z.coerce.number().int().positive().default(3_600),
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(5_184_000),
  REFRESH_GRACE_SEC: z.coerce.number().int().positive().default(30),
})

// infra/config/env.ts
const schema = coreEnvSchema.extend(authEnvSchema.shape)  // .merge() é deprecado no Zod 4
export const env = schema.parse(process.env)
export type Env = z.infer<typeof schema>
```

> **`.int().positive()` não é preciosismo.** `z.coerce.number()` sozinho converte
> string vazia em **`0`** em silêncio. Uma linha `REFRESH_TOKEN_TTL=` no `.env`
> produziria refresh expirado no ato, e `REFRESH_GRACE_SEC=` zeraria a janela de
> graça — devolvendo exatamente o logout aleatório que a §13 chama de "bug
> infernal de reproduzir". Vale para **toda** env numérica.

> **Só `infra/config/env.ts` lê `process.env`.** *(R6)* Com o acesso restrito e a
> config injetada, esquecer de registrar o schema no merge vira **erro de
> compilação** — desde que `authConfigOf` (§7) derive o tipo do próprio schema.

---

## 12. Observabilidade

**O use case não loga e não recebe logger.** *(decisão 15)*

```ts
// infra/observability/context.ts
const als = new AsyncLocalStorage<{ traceId: string }>()

export const runWithContext = (id: string, fn: () => void) => als.run({ traceId: id }, fn)
export const traceId        = () => als.getStore()?.traceId

// hook do Fastify
app.addHook('onRequest', (req, _reply, done) => runWithContext(req.id, done))
```

> Esse padrão **funciona** no Fastify 5, inclusive com corpo grande e keep-alive:
> o content-type-parser religa o contexto com `AsyncResource` depois de ler o
> corpo. Com `node:http` cru o contexto se perderia — a armadilha é real, o
> Fastify a neutraliza.

**`traceId()` é `string | undefined`.** Use `traceId() ?? req.id` ao montar o
corpo de erro. E **`worker.ts` e `cron.ts` precisam envelopar cada execução em
`runWithContext`**, senão todo log deles fica sem correlação.

Configure `requestIdLogLabel: 'traceId'` no Fastify — caso contrário ele loga
`reqId` e o error handler loga `traceId` para o mesmo valor, derrotando o grep
único que justifica o desenho.

| Origem | Registra |
|---|---|
| Fastify | request, status, duração, `traceId` |
| `error-handler.ts` | erro completo + `traceId` |
| `infra/` | query lenta, falha de driver |
| Taxonomia de erro | o `code` já indica qual ramo falhou |

### Redação de segredo

```ts
redact: {
  paths: [
    'password', 'token', 'refreshToken', 'accessToken',      // raiz
    '*.password', '*.token', '*.refreshToken',
    'headers.authorization', 'headers.cookie',
    'req.headers.authorization', 'req.headers.cookie',
    'req.body.password', 'req.body.refreshToken',
    'res.headers["set-cookie"]',
  ],
  censor: '[REDACTED]',
}
```

> ⚠️ **`redact` do pino NÃO é recursivo** — `*.x` casa exatamente um nível, e
> array de objetos escapa. A lista acima cobre os casos conhecidos, não todos.
> Por isso vale a regra complementar, que é a que realmente protege: **nunca
> logar entidade de domínio nem objeto de request inteiro.** Logue campos
> escolhidos.
>
> Note também que o serializer `req` padrão do Fastify não emite headers — os
> paths `req.headers.*` só agem se um serializer customizado os incluir.

**OpenTelemetry** não está adotado, mas o desenho o antecipa: o consumidor chama
`traceId()` sem conhecer o mecanismo, então migrar é trocar um arquivo.

---

## 13. Autenticação

*(decisões 11 e 12)*

```
senha    argon2id  (IHashProvider — SÓ para senha de usuário)
access   JWT, 1h, sempre via Authorization: Bearer
refresh  token opaco de 32 bytes, 60d deslizante, rotaciona a cada uso
         + janela de graça de 30s
         + detecção de reuso -> revoga a família
```

```
tabela refresh_tokens
  id · user_id · token_hash · family_id
  expires_at · revoked_at · replaced_by · created_at

  token_hash = sha256(token)   -- determinístico, ÍNDICE ÚNICO
```

> **`token_hash` é SHA-256, não argon2.** Argon2 usa salt aleatório, então
> `WHERE token_hash = ?` nunca casaria e a busca degeneraria em varrer a tabela
> rodando argon2 por linha — DoS de CPU num endpoint de alta frequência. Token
> opaco de 32 bytes já tem entropia; precisa de digest determinístico e indexável,
> não de key stretching.

### Transporte por tipo de cliente

| | mobile | web (SPA / admin) |
|---|---|---|
| access — transporte | `Authorization: Bearer` | `Authorization: Bearer` |
| access — onde fica | **memória** | **memória** (variável JS) |
| refresh — transporte | corpo do `POST /auth/refresh` | cookie `httpOnly` |
| refresh — onde fica | **Keychain / Keystore** | o próprio cookie |

```
Set-Cookie: refresh_token=<opaco>
  HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh; Max-Age=5184000
```

O **access nunca é persistido**: vive em memória e morre com o processo. Persistir
o access anula a razão de ele ser curto.

**Toda rota autenticada lê `Authorization`.** Como site malicioso não forja header
em requisição cross-site, a API é imune a CSRF por construção — não há token
anti-CSRF em lugar nenhum. O cookie existe só em `/auth/refresh`, com
`SameSite=Strict`.

### Rotação e janela de graça

```
refresh chega DENTRO de 30s da rotação anterior
  -> aceita, emite par NOVO na mesma família, sem disparar detecção

refresh chega FORA da janela, já rotacionado
  -> vazamento: revoga a família inteira
```

> **Por que "par novo" e não "o mesmo par".** Só o hash é persistido; o servidor
> não consegue reproduzir o token em claro que emitiu.

> **A rotação inteira roda dentro de `uow.run`, com `SELECT ... FOR UPDATE` na
> linha atual.** Sem a trava, dois refresh simultâneos com o mesmo token passam os
> dois e **a detecção de reuso nunca dispara**. O índice único em `token_hash` é a
> segunda barreira.

**Sem a janela de graça**, um refresh cuja resposta se perdeu (rede móvel
instável) faz o cliente repetir com o token anterior, a detecção interpreta como
vazamento e o usuário é deslogado sem motivo.

### Escopo de revogação

| Evento | Revoga |
|---|---|
| Detecção de reuso | **a família** do token reusado — só aquele dispositivo |
| Logout daquele dispositivo | a família daquele dispositivo |
| Troca de senha | **todas as famílias do usuário** |
| Usuário banido | **todas as famílias do usuário** |
| Logout em todos os dispositivos | **todas as famílias do usuário** |

Família é por login/dispositivo. Confundir "revogar a família" com "revogar tudo"
é falha de segurança: troca de senha que revoga só uma família deixa a sessão do
atacante viva.

A latência da revogação é o TTL do access — 1h.

> **Restrição de deploy:** `SameSite` opera por domínio registrável.
> `api.exemplo.com` + `app.exemplo.com` funciona; domínios registráveis distintos
> tornam o par cross-site, exigem `SameSite=None` e reabrem CSRF.
>
> **CORS:** requisição cross-origin com credencial exige
> `Access-Control-Allow-Credentials: true` e allowlist explícita de origem —
> `*` é inválido nesse modo.

> ⚠️ **EM ABERTO:**
> - **Rate limiting / brute force no login.** Sem isso, o oráculo de timing da §5
>   e a força bruta de senha não têm nenhuma barreira.
> - **Teto absoluto de sessão.** 60 dias é janela *deslizante*: um refresh usado
>   com regularidade nunca expira. Decidir se há limite absoluto.

---

## 14. Testes

| Tipo | Onde | Dependências | Velocidade |
|---|---|---|---|
| Unitário | colocado (`*.spec.ts`) | in-memory + fakes | milissegundos |
| Integração | `tests/integration/` | Postgres real (`app_test`) | segundos |

*(decisões 09 e 17)*

O teste unitário usa `InMemoryUsersRepository` e um `IClock` fake, e **nunca**
toca banco, rede ou relógio real. É R7 que torna isso possível: como o use case
não chama `new Date()`, o teste controla o tempo passando outro relógio.

**Casos obrigatórios de integração**, porque são fáceis de errar de forma sutil e
o erro é de segurança:

- rotação de refresh e a janela de graça
- detecção de reuso, incluindo **dois refresh concorrentes com o mesmo token**
- escopo de revogação: troca de senha revoga **todas** as famílias
- os fixtures de fronteira da §3, escritos com `#`, que precisam **falhar**

O banco `app_test` vive na mesma instância Postgres do compose. Migrations rodam
uma vez antes da suíte; `TRUNCATE ... CASCADE` isola os testes.

---

## 15. Ambiente, build e CI

### Desenvolvimento

```bash
docker compose up -d   # sobe só a infra: postgres (e futuros redis, mailhog)
pnpm dev               # aplicação roda no HOST
```

`.nvmrc` e `engines` travam a versão do Node, e **o CI roda em container**, então
deriva de ambiente aparece no pipeline. *(decisão 16)*

### Imports

Não há path alias. O projeto usa **subpath imports do Node**. *(decisão 19)*

```jsonc
// package.json
"type": "module",
"imports": {
  "#modules/*": { "development": "./src/modules/*.ts", "default": "./dist/modules/*.js" },
  "#shared/*":  { "development": "./src/shared/*.ts",  "default": "./dist/shared/*.js"  },
  "#infra/*":   { "development": "./src/infra/*.ts",   "default": "./dist/infra/*.js"   }
}
```

**Duas regras de import, sem exceção:**

- **Entre diretórios de topo** (`#modules/...`, `#shared/...`, `#infra/...`) — é a
  forma que o `dependency-cruiser` inspeciona.
- **Dentro da mesma pasta**, caminho relativo **com extensão `.js`**:
  `import { toDomainUser } from './user-mapper.js'`. ESM com `nodenext` **exige** a
  extensão; sem ela o `tsc` falha com `TS2835`.

### tsconfig — contrato mínimo

```jsonc
{
  "compilerOptions": {
    "module":           "nodenext",
    "moduleResolution": "nodenext",
    "rootDir":          "src",       // obrigatório
    "outDir":           "dist",      // precisa bater com o mapa `imports`
    "customConditions": ["development"]
  }
}
```

> `rootDir` e `outDir` **não são opcionais**: sem eles o `tsc` não consegue mapear
> `./dist/x.js` de volta para `./src/x.ts` e falha com `TS2307` em todo import `#`.

### Scripts

```jsonc
"dev":   "tsx --conditions=development src/main/http.ts",
"build": "tsc",
"start": "node dist/main/http.js"
```

> **Sem `--conditions=development` o mapa cai no `default`** e o processo tenta
> resolver `dist/`, que em desenvolvimento não existe. O Vitest resolve `#` sem
> configuração adicional.

### Imagem de produção

Multi-stage, usuário não-root, e **`pnpm install --prod --frozen-lockfile`** no
estágio de runtime.

> **Não use `pnpm deploy --prod`**: ele só funciona dentro de um workspace, e este
> repositório é um pacote único (`ERR_PNPM_CANNOT_DEPLOY`).
>
> O `package.json` **precisa ir para a imagem final** — é o campo `imports` que faz
> os especificadores `#` resolverem em runtime.

### Pipeline

```yaml
# .github/workflows/ci.yml
services: { postgres: { image: postgres:17 } }
steps:
  - pnpm install --frozen-lockfile   # lockfile divergente falha aqui
  - pnpm lint                        # ESLint: R6, R7
  - pnpm check:boundaries            # dependency-cruiser: a fronteira da §3
  - pnpm typecheck
  - pnpm test:unit
  - drizzle-kit migrate              # contra app_test
  - pnpm test:integration
  - pnpm build
```

---

## 16. Regras invioláveis

| | Regra | Evita |
|---|---|---|
| **R1** | Repositório usa só a API core do Drizzle — nunca `db.query.*` | Reescrita dos repositórios quando a Relational Queries V2 chegar |
| **R2** | Coluna sempre nomeada explicitamente: `id: uuid('id')` | O `casing-rework` do Drizzle renomear colunas do schema |
| **R3** | Não cortar um "1.0" do boilerplate antes do GA do Drizzle | Converter formato de migration em N apps em vez de 1 |
| **R4** | Migrations são forward-only, com expand/contract | Depender de rollback que o Drizzle v1 não entrega |
| **R5** | Comunicação entre módulos só via use case ou contrato | Chamada HTTP interna, reuso de handler e import de `infra/` de outro módulo |
| **R6** | Só `infra/config/env.ts` lê `process.env` | Env var não validada chegar como `undefined` em produção |
| **R7** | Use case não gera valor não determinístico — tempo e aleatoriedade vêm por contrato | Teste de expiração e janela de graça impossível de escrever |

---

## 17. O que ainda não está decidido

| Assunto | Onde | Impacto de continuar aberto |
|---|---|---|
| Superfície pública do módulo | §3, §6 | `ensure-authenticated` fica como exceção declarada; o alcance de `pure → pure` entre módulos segue sem qualificador |
| Configuração do `dependency-cruiser` | §3 | A regra está especificada, mas **nada é garantido até a config e os fixtures existirem** |
| Rate limiting no login | §5, §13 | Oráculo de timing e força bruta sem barreira |
| Teto absoluto de sessão | §13 | Refresh usado com regularidade nunca expira |
| `entities/` não importar `use-cases/` | §3 | Regra opcional, não adotada |
| RBAC / permissões | — | Se roles forem para o JWT, herdam a janela de 1h da §13 |

---

## 18. Referências

- [`docs/DECISIONS.md`](DECISIONS.md) — as 23 decisões com motivo,
  alternativas descartadas e os dados que sustentaram cada escolha
- Decisões em aberto e pendências de manutenção: seções 6 e 7 daquele documento

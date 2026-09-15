# Fatia 15 — Seed do banco local de dev (`pnpm db:seed`): design

> Escrito em 2026-09-14, depois do merge da fatia 14 (PR #9). Não vem do
> `docs/TODO.md`: é tooling de desenvolvimento pedido antes do próximo item de
> produto, para que as fatias seguintes sejam testadas à mão sobre um estado
> conhecido.
>
> Referência de comportamento: o `db:seed` do byteflow
> (`apps/api/src/seeds/`). O desenho abaixo reproduz a experiência de uso e
> diverge na estrutura onde as fronteiras deste repositório exigem.

## 1. O que esta fatia entrega

- **`pnpm db:seed`** — leva o banco local a um estado conhecido e reproduzível.
  Numa transação só, apaga o **namespace de seed** (`@seed.local`) de cada
  módulo e roda os cenários pedidos. Rodar duas vezes dá o mesmo estado; dado
  criado à mão no dev não é tocado.
- **Cenários por módulo**, com `dependsOn` qualificado (`auth:base-users`) e a
  mesma CLI do byteflow: default, nomes, `--all`, `--list`.
- **Os scripts de banco que o byteflow tem e este repositório não:** `db:up`,
  `db:down`, `db:logs`, `db:studio` — e `db:generate`/`db:migrate` passam a ler
  o `.env`.

## 2. Fora de escopo

- **Snapshots do banco local** (salvar/restaurar estados nomeados). Levantado no
  brainstorming e adiado pelo usuário — o byteflow não tem, e o pedido é
  paridade.
- **Puxar dados de outro ambiente** (staging/prod → local).
- **`db:reset`.** Não existe no byteflow; `docker compose down -v` resolve.
- **Seed de `refresh_tokens` e `password_reset_tokens`.** Login e `forgot`
  produzem os dois de verdade; um seed deles só envelheceria.
- **Semear qualquer banco que não seja local.** Ver §7 — é outra decisão, não
  uma flag.

## 3. Decisões tomadas no brainstorming

### 3.1 — Cenários por módulo, runner no composition root

Três caminhos foram comparados:

| | A — por módulo + `main/` | B — `src/seeds/` global | C — via use cases |
|---|---|---|---|
| Fronteira no scanner | limpa (§4) | `LAYER-UNKNOWN`; pasta global conhecendo a infra de todo módulo | limpa |
| Chega a qualquer estado (Google, pendente com código conhecido) | sim | sim | não sem fakes |
| Uma transação, re-run idêntico | sim | sim | não — cada use case abre a sua unit of work, e o runner recusa aninhamento |
| Depende de Mailpit/SMTP | não | não | sim — o código de seis dígitos só existe no e-mail |

**Escolhido: A.** C é o que a suíte de integração já faz, e é teste, não dado de
dev. B copia o byteflow ao custo de uma camada nova no mapa de fronteira e de um
ponto único que conhece o concreto de todos os módulos.

### 3.2 — As factories escrevem por entidade + repositório Drizzle

`User.create` / `User.createFederated`, `FederatedIdentity.create` e
`PendingRegistration.create` existem, e os repositórios Drizzle recebem
`Database` — que inclui a transação. O seed usa esses caminhos em vez de insert
cru: as invariantes das entidades e os mappers valem para ele como valem para a
API, e uma coluna nova quebra o seed na compilação em vez de gravar linha
incompleta. `id` vem do `UuidIdGenerator`, `now` do `SystemClock`, o hash do
código do `Sha256TokenDigest` — os providers da aplicação.

A **única escrita crua é o `wipe`** (§5.3): um `deleteByEmailDomain` não tem
lugar no contrato de repositório de produção.

### 3.3 — Duas travas de alvo, sem flag de contorno

Diverge do byteflow, que só recusa `NODE_ENV=production`. Ver §7.

### 3.4 — A senha de seed não vai para o log

O byteflow imprime a senha no fim do run. Aqui o audit classifica senha em log
como CRÍTICA, e "é só dev" é a racionalização que ele recusa. O log leva os
e-mails; a senha fica documentada no `src/modules/auth/README.md`, ao lado da
constante.

## 4. Onde cada peça mora

```text
src/infra/database/seeds/
└── seed-module.ts          # o contrato: SeedModule, SeedScenario, SeedRunContext
src/modules/auth/infra/seeds/
├── factories.ts            # SEED_EMAIL_DOMAIN, createPasswordUser, createGoogleUser, createPendingRegistration, wipe
├── base-users.ts           # cenário auth:base-users + seus e-mails
├── pending-registration.ts # cenário auth:pending-registration + e-mail e código
└── index.ts                # authSeedModule + SEED_PASSWORD
src/main/seeds/
├── runner.ts               # seleção, ordem, travas, transação
├── runner.spec.ts
└── index.ts                # casca da CLI: argv, log, exit code
tests/integration/
└── seed.spec.ts
```

| Arquivo | Camada (scanner) | Importa | Por que é permitido |
|---|---|---|---|
| `src/infra/database/seeds/*` | `global-infra` | `#infra/database/client` (tipo) | `global-infra → global-infra`; nenhum `#modules` |
| `src/modules/auth/infra/seeds/*` | `module-infra` | pura do `auth`, `infra/` do `auth`, `#infra/*` | exatamente a linha `module-infra` da tabela |
| `src/main/seeds/*` | `composition` | tudo | é o composition root |

- **O contrato fica em `#infra`, não em `#main` nem em `#shared`.** `#main` faria
  o seed do módulo disparar `INFRA-MAIN`; `#shared` é camada pura e não pode
  citar `Database`.
- **Os cenários não entram no container.** Nada de dado de dev no grafo de
  produção, e nenhum container importado fora das regras.
- **Dependência entre módulos é por nome.** Um futuro `billing` declara
  `dependsOn: ['auth:base-users']` e resolve o usuário por e-mail — sem import,
  sem `XMOD-INFRA`.

## 5. O contrato e o módulo `auth`

### 5.1 — Contrato

```ts
/** What a module publishes for `pnpm db:seed`. Never reaches the container. */
export interface SeedModule<TPreparation = unknown> {
  /** Prefix for its scenarios: `auth` → `auth:base-users`. */
  readonly name: string
  /** Runs BEFORE the transaction opens — CPU-heavy work (argon2) goes here. */
  prepare(): Promise<TPreparation>
  /** Deletes only this module's seed namespace. Runs inside the transaction. */
  wipe(tx: Database): Promise<void>
  readonly scenarios: readonly SeedScenario<TPreparation>[]
}

export interface SeedScenario<TPreparation = unknown> {
  /** kebab-case, unqualified. */
  readonly name: string
  /** One line for `--list`. */
  readonly description: string
  /** Selected when `pnpm db:seed` runs with no target. */
  readonly byDefault?: boolean
  /** Qualified names: `auth:base-users`. */
  readonly dependsOn?: readonly string[]
  run(ctx: SeedRunContext<TPreparation>): Promise<void>
}

export interface SeedRunContext<TPreparation = unknown> {
  tx: Database
  /** One instant for the whole run. */
  now: Date
  /** What the module's `prepare()` returned. */
  preparation: TPreparation
  /** Prefixed with the qualified scenario name. */
  log(message: string): void
}
```

O módulo declara o próprio tipo — no `auth`,
`SeedModule<{ passwordHash: string }>` — e o runner guarda
`readonly SeedModule[]`, isto é, `SeedModule<unknown>`. A atribuição compila sem
`any` porque `run` e `prepare` são declarados com **sintaxe de método**, que o
TypeScript checa bivariantemente; declarados como propriedade-função
(`run: (ctx) => …`), a atribuição falharia. O runner só repassa a `preparation`
que o próprio módulo produziu ao cenário daquele módulo, então a bivariância não
abre caminho para um tipo errado chegar a um cenário.

**Por que `prepare()` e não um cache de hash como no byteflow:** todo usuário de
seed usa a mesma senha, então o hash é calculado uma vez, antes da transação —
argon2 fora de transação aberta, como a §8 exige — e o cache deixa de ter o que
cachear. Não há senha por usuário.

### 5.2 — Cenários

| Cenário | Default | Cria |
|---|---|---|
| `auth:base-users` | ✅ | `dev@seed.local` — senha `SEED_PASSWORD`, verificado (`User.create`) |
| | | `google@seed.local` — só Google: `User.createFederated` (`password_hash` nulo) + `FederatedIdentity` com `providerUserId` fixo |
| `auth:pending-registration` | — | registro pendente de `pending@seed.local` com o código `SEED_VERIFICATION_CODE`, digerido pelo `Sha256TokenDigest` |

- `dev@` cobre login, `/me`, refresh, troca e recuperação de senha (o e-mail
  cai no Mailpit).
- `google@` cobre o login por senha numa conta sem senha e é a base dos miúdos
  da fatia 14 (definir a primeira senha, listar provedores).
- `pending@` permite exercitar `POST /auth/email/verify` sem abrir o Mailpit.
  O TTL é `SEED_PENDING_REGISTRATION_TTL_SECONDS` (sete dias), próprio do seed:
  o módulo de seed não recebe a config do container, e um código que expira em
  minutos não serve a quem semeia de manhã e testa à tarde.

Cada constante mora no arquivo que a usa, como o `CLAUDE.md` pede; não há
`constants.ts`. A única reusada entre arquivos é `SEED_EMAIL_DOMAIN`, e ela fica
em `factories.ts`, ao lado do `wipe` que apaga por ela.
`SEED_PASSWORD` tem ao menos o piso de oito caracteres do `Password`.

### 5.3 — `wipe` do `auth`

```sql
DELETE FROM users                 WHERE lower(email) LIKE '%@seed.local';
DELETE FROM pending_registrations WHERE lower(email) LIKE '%@seed.local';
```

`refresh_tokens`, `federated_identities` e `password_reset_tokens` somem pela
cascata de `users`. `pending_registrations` não tem FK e é apagada
explicitamente. O domínio vem de `SEED_EMAIL_DOMAIN`, nunca literal.

## 6. Runner e CLI

### 6.1 — CLI (`src/main/seeds/index.ts`)

```bash
pnpm db:seed                             # default: auth:base-users
pnpm db:seed auth:pending-registration   # o cenário + seus dependsOn
pnpm db:seed auth                        # todos os cenários do módulo
pnpm db:seed --all
pnpm db:seed --list
```

Módulo sozinho seleciona o módulo inteiro — a mesma regra do seletor do
`cron.ts`. Casca no formato do `cron.ts`: lê argv, chama o runner, loga com
`createLogger(env)`, sai com código.

| Exit | Quando |
|---|---|
| `0` | seed completo |
| `1` | seed falhou: banco, trava de alvo (§7), cenário que lançou, ciclo ou `dependsOn` inexistente — os dois últimos são defeito no código dos cenários, não na linha de comando |
| `2` | invocação errada: cenário ou módulo pedido na linha de comando não existe — a mensagem lista os disponíveis |

### 6.2 — Runner (`src/main/seeds/runner.ts`)

- `SEED_MODULES = [authSeedModule]`, **à mão**, como o `AUTH_MODULE` do
  `run-cron.ts`: um módulo esquecido aqui fica sem seed, então a linha tem que
  aparecer no diff.
- Funções puras, testáveis sem banco: `qualifyScenarios`, `selectScenarios`,
  `resolveOrder` (ordem topológica; ciclo e `dependsOn` desconhecido lançam
  citando quem pediu) e `assertSeedTarget(env)`.
- `runSeed(env, logger, selectors, modules = SEED_MODULES)`:
  1. `assertSeedTarget(env)`;
  2. resolve seleção e ordem **antes** de abrir conexão — o registry é
     estático, não há container a consultar. Os defaults são os cenários com
     `byDefault: true`, declarados pelo próprio módulo: o runner não conhece
     nome de cenário nenhum;
  3. `createDatabase(env)` e `prepare()` de cada módulo;
  4. `createTransactionRunner` — uma transação: `wipe` de **todos** os módulos
     em ordem inversa de `SEED_MODULES`, depois os cenários em ordem;
  5. `pool.end()` no `finally`.

O `wipe` roda para todos os módulos, não só os dos cenários pedidos: sem FK
entre módulos, a cascata do `auth` nunca alcança outro módulo, e o re-run só é
idêntico se cada um limpa o seu. O parâmetro `modules` existe para o teste
injetar um módulo que falha.

## 7. Travas de alvo

`assertSeedTarget(env)` recusa, sem flag de contorno:

1. `env.NODE_ENV === 'production'`;
2. host de `env.DATABASE_URL` fora de `localhost`, `127.0.0.1`, `::1`.

**Por que a segunda:** o `env.ts` usa `development` como default de `NODE_ENV`.
Um shell de servidor sem a variável, ou um `.env` apontando para staging, passa
pela primeira trava — e o seed criaria `dev@seed.local` **com senha conhecida e
documentada** num banco remoto: uma conta de backdoor. Semear staging, se um dia
fizer sentido, é outra decisão.

A integração passa pelas duas: o `vitest.config.ts` injeta `NODE_ENV=test` e o
`TEST_DATABASE_URL` em `127.0.0.1:5433`.

## 8. Scripts

```jsonc
"db:up":       "docker compose up -d --wait",
"db:down":     "docker compose down",
"db:logs":     "docker compose logs -f postgres",
"db:generate": "node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs generate",
"db:migrate":  "node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs migrate",
"db:studio":   "node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs studio",
"db:seed":     "node --conditions=development --env-file-if-exists=.env --import tsx src/main/seeds/index.ts"
```

- `db:seed` não usa `tsx` direto como no byteflow: o mapa de `imports` precisa da
  condição `development` para `#modules/*` resolver para `src/`, igual ao
  `pnpm dev`.
- O CI não muda: com `--env-file`, variável já presente no ambiente vence a do
  arquivo, então o `DATABASE_URL` que o workflow injeta no `db:migrate` segue
  valendo.
- `db:down` sem `-v`: o volume do dev sobrevive.

## 9. Build e documentação

- **`tsconfig.build.json`:** `**/seeds/**` no `exclude`, com o comentário no
  formato do de `fixtures/` e `in-memory/`. Nada de produção importa seed; se
  algum dia importar, o build quebra alto.
- **`ARCHITECTURE.md`:** §2 ganha as três pastas na árvore; §10 os comandos
  novos.
- **`docs/DECISIONS.md`:** decisão 32 — contrato em `#infra`, cenários por
  módulo fora do container, `wipe` por módulo, travas de alvo, exclusão do
  build.
- **`src/modules/auth/README.md`:** os usuários de seed e a senha.
- **`docs/TODO.md`:** registra a fatia e corrige a entrada de CORS, que consta
  como pendente mas já está em `src/infra/http/cors.ts`.

## 10. Testes

### 10.1 — Unitário (`src/main/seeds/runner.spec.ts`)

- `selectScenarios`: sem seletor → default; `--all`; módulo; nome qualificado;
  desconhecido → erro de invocação listando os disponíveis.
- `resolveOrder`: dependência transitiva antes do dependente; ciclo lança;
  `dependsOn` inexistente lança citando o cenário que o declarou; cenário pedido
  duas vezes roda uma vez.
- `assertSeedTarget`: `production` recusado; host remoto recusado; `localhost`,
  `127.0.0.1` e `::1` aceitos.

### 10.2 — Integração (`tests/integration/seed.spec.ts`, contra `postgres-test`)

- **Re-run idêntico:** dois `runSeed` seguidos dão os mesmos e-mails e as mesmas
  contagens por tabela.
- **Dado fora do namespace sobrevive:** um usuário do `arrangeAccount` continua
  lá depois do seed.
- **Caminho real:** `dev@seed.local` loga via `POST /auth/login` com
  `SEED_PASSWORD` — prova hash, mapper e verificação.
- `google@seed.local` tem `password_hash` nulo e uma linha em
  `federated_identities`.
- `pending@seed.local` confirma via `POST /auth/email/verify` com
  `SEED_VERIFICATION_CODE`.
- **Atomicidade:** com um `SeedModule` falso cujo cenário lança, o estado
  anterior ao run fica intacto.

## 11. Custos aceitos

- **Dependência entre módulos por string.** Um `dependsOn` com typo só falha em
  runtime — no `resolveOrder`, antes de abrir conexão, com a mensagem citando o
  cenário. Tipar os nomes entre módulos exigiria import entre módulos.
- **O `wipe` do `auth` assume o domínio do e-mail como marca de seed.** Um
  usuário real cadastrado com `@seed.local` no banco de dev seria apagado. É
  domínio reservado para uso local, e o banco é local por trava (§7).
- **O seed pode gravar estado que a API não grava** (código conhecido, TTL de
  sete dias). É o motivo de ele existir; o preço é que um cenário mal escrito
  cria lixo — limitado ao namespace e apagado no próximo run.

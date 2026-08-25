# Tabela `users` e a primeira migration

**Status:** aprovado, pronto para plano de implementação.
**Data:** 2026-08-25

## 1. Contexto e escopo

O `drizzle.config.ts` aponta para o glob `./src/modules/*/infra/drizzle/schema.ts`,
que **hoje não casa com nada**: `src/modules/` não existe. A pasta `drizzle/`
está vazia, e o passo `pnpm db:migrate` do CI (decisão 17, implementada em
`275f62d`) roda sobre ela sem aplicar nada. Ou seja: **o caminho
`db:generate` → SQL commitada → `db:migrate` → CI nunca foi exercido neste
repositório.**

Esta fatia existe para exercê-lo com o menor artefato possível, isolando
"o pipeline de migration funciona" de "o domínio está certo".

**Entra:**

- `src/modules/auth/infra/drizzle/schema.ts` com a tabela `users` — o primeiro
  arquivo sob `src/modules/`.
- A migration `0000` gerada e commitada.
- Um `globalSetup` do Vitest aplicando migrations no banco de teste antes da
  suíte de integração (ver §6).
- Um teste de integração que prova a migration.
- Uma exceção na `CLAUDE.md` para nomes em arquivo de schema (ver §5).

**Não entra:**

- Entidade `User`, `Email` value object, `IUsersRepository`, mapper,
  `DrizzleUsersRepository`, use case, endpoint.
- `container.ts` e `config.ts` do módulo (decisões 08, 23, 14).
- `IClock` e `IIdGenerator` (decisão 21) — esta fatia apenas **assume** que
  existirão e desenha o schema de acordo (ver §4).
- A tabela `refresh_tokens` (ver §7).
- Regra de fronteira no lint — depende de haver mais de um módulo para
  significar algo.

## 2. A ordem escolhida: infra antes do domínio

O §10 do `STRUCTURE.md` prescreve o inverso — *"Domínio primeiro: entidade e
value objects. Sem pensar em banco nem HTTP"*, com infra no passo 5. Esta fatia
**inverte deliberadamente** essa ordem, uma vez.

Motivo: o pipeline de migration não tem prova nenhuma, e prová-lo com uma
tabela mínima separa duas classes de falha que, feitas juntas, se confundem.
Antes de existir dado em produção, refazer a migration `0000` custa
praticamente zero — então o risco de desenhar a tabela cedo é baixo, e o
benefício de destravar o pipeline é imediato.

A inversão **não vira precedente**: do módulo `auth` em diante, o §10 vale como
escrito. Esta é uma fatia de bootstrap, não um novo padrão.

## 3. Origem da identidade e do tempo — a R7 é mantida inteira

A R7 proíbe `new Date()`, `Date.now()`, `Math.random()` e `crypto.randomUUID()`
na camada pura; tempo e aleatoriedade entram por contrato (`IClock`,
`IIdGenerator`, decisão 21). Isso foi reavaliado nesta fatia e **mantido**.

### O que a investigação mostrou

Foram levantados dois fatos empíricos que invertem a intuição:

| Verificação | Resultado |
|---|---|
| `crypto.randomUUID({ version: 7 })` no Node 24 | **Não lança erro** e devolve um **v4** — a opção é ignorada em silêncio |
| `uuidv7()` no `postgres:18.4-alpine3.24` (container do projeto) | Existe e devolve v7 corretamente |

Ou seja, o único UUIDv7 disponível está do lado que a R7 quer evitar.

### O que o `byteflow` mostrou

O projeto `~/projects/byteflow` roda quatro módulos **sem** a R7, e a
comparação foi feita a favor dele:

- Ele lida com tempo por três mecanismos: duração como parâmetro de construtor
  (`ttlMs`, `graceMs`, `cooldownMs`), duração negativa para nascer no passado
  (`RefreshToken.issue({ ttlMs: -1000 })`), e `now` como parâmetro opcional em
  predicados (`isActive(now: Date = new Date())`).
- O teste da janela de graça **não move o relógio, move o limiar**: `setup(0)`
  para "definitivamente fora", `setup(60_000)` para "definitivamente dentro".
- Varredura do repositório: **zero `useFakeTimers`, zero `setSystemTime`**, e
  nenhuma asserção enfraquecida por falta de clock.

O truque cobriu 100% dos casos deles. Isso é registrado aqui porque é evidência
**contra** a necessidade da R7, e omiti-la tornaria esta spec uma peça de
retórica.

### Por que a R7 fica, mesmo assim

Uma razão só, mas precisa: **mover o limiar prova os dois extremos, mas não
sonda a fronteira.** `setup(0)` e `setup(60_000)` nunca exercitam ~29,9s e
~30,1s — que é exatamente onde vive um bug de janela de graça (`<` vs `<=`, ou
comparar contra `createdAt` em vez de `revokedAt`).

Isso pesa mais aqui do que lá porque a decisão 11 deste projeto define a janela
de 30s como mecanismo **anti-logout-fantasma**, cujo modo de falha é silencioso
e irreproduzível em produção.

Os dois contratos têm justificativas **diferentes**, e vale não confundi-las:

- **`IClock`** — barato, e paga pela sondagem de fronteira acima.
- **`IIdGenerator`** — ganho de testabilidade ≈ zero (ninguém assere um UUID
  específico). O que ele compra é **trocabilidade**: v4 → v7, ULID ou id com
  prefixo (`usr_...`) vira a troca de um arquivo. Num boilerplate copiado N
  vezes, é seguro barato — mas é seguro, não testabilidade.

### A consequência para o schema

**O app é a fonte; o default do banco é defense-in-depth.** A partir da fatia 2,
`IIdGenerator` e `IClock` produzem `id`, `createdAt` e `updatedAt`, e o
repositório os envia explicitamente. Os defaults da coluna cobrem apenas
escrita direta (seed, `psql`, migration de dados).

O `id` fica em **v4** (`.defaultRandom()` → `gen_random_uuid()`), com o provider
usando `crypto.randomUUID()` — zero dependência nova. Migrar para v7 depois é
trocar a implementação do provider e emitir uma migration que altera o default;
é justamente o que o contrato torna barato.

## 4. O schema

Arquivo: `src/modules/auth/infra/drizzle/schema.ts`.

```ts
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`)],
)
```

Escolhas, com motivo:

- **Índice único funcional em `lower(email)`, não `citext`.** Dá unicidade
  case-insensitive sem `CREATE EXTENSION`, ou seja, uma dependência de infra a
  menos em cada banco derivado. Pressupõe que o app normaliza o e-mail para
  minúsculas — responsabilidade do `Email` value object na fatia 2.
- **`timestamptz` nos dois timestamps.** `timestamp` sem timezone é fonte
  clássica de bug em deploy multi-região.
- **`text`, não `varchar(n)`.** No Postgres não há diferença de performance, e
  limite de tamanho é regra de domínio — pertence ao value object, não à coluna.
- **R2 respeitada:** toda coluna nomeada explicitamente, nenhuma inferência de
  casing.
- **`$onUpdate` é seguro sob a R7.** Verificado no fonte do Drizzle
  (`pg-core/dialect.js`, `buildUpdateSet`): o valor é
  `set[colName] ?? onUpdateFnResult`. É `??`, então **não sobrescreve** valor
  explícito — só preenche quando a coluna está ausente do `set`. Convive com o
  `IClock` sem criar fonte concorrente.

## 5. Exceção de nomes na `CLAUDE.md`

A regra de no-magic-strings é aplicada estritamente neste repositório — em
`src/infra/http/endpoints/health.ts` até `'/health'`, `'ok'` e `'up'` são
constantes. Aplicá-la a nome de tabela e de coluna produziria sete constantes
usadas uma vez cada, dentro do arquivo que **é** a declaração desses nomes.

Decisão: a `CLAUDE.md` ganha uma exceção explícita para
`src/modules/*/infra/drizzle/schema.ts`, cobrindo **apenas** os nomes de tabela,
coluna e índice. Qualquer outro literal nesses arquivos segue a regra.

Registrado como decisão explícita, e não como desvio silencioso, porque vale
para todo módulo futuro.

## 6. Migration, e o furo que ela abre no fluxo local

`pnpm db:generate` produz `drizzle/0000_*.sql`, que é **commitada**.
Forward-only, sem `down` (R4).

Isso quebra o `pnpm test:integration` local, e o motivo merece registro: o banco
de teste é `tmpfs` (some a cada restart do container) e **nada aplica migration
antes da suíte**. Não fazia falta enquanto não havia tabela. O CI já faz certo —
`pnpm db:migrate` antes de `pnpm test:integration` — então só o fluxo local
ficaria para trás, e a falha apareceria como um erro de tabela inexistente, não
como "faltou migrar".

**Solução:** um `globalSetup` do Vitest, registrado **apenas no projeto
`integration`**, chamando `migrate()` de `drizzle-orm/node-postgres/migrator`
(confirmado presente no `1.0.0-rc.4`). É idempotente — o Drizzle registra as
migrations já aplicadas.

**Duplicação a resolver junto:** a `TEST_DATABASE_URL` é hoje um literal em
`vitest.config.ts` e está **duplicada** em `.github/workflows/ci.yml`. O
`globalSetup` seria a terceira cópia. Em vez disso, a constante é extraída para
um módulo que tanto `vitest.config.ts` quanto o `globalSetup` importam. O CI
mantém a cópia dele — o comentário do workflow já a documenta como deliberada,
já que o service container precisa do valor antes de qualquer código rodar.

## 7. O que ficou de fora, e por quê

Colunas presentes na tabela equivalente do `byteflow` que **não** entram aqui:

| Coluna | Por que não |
|---|---|
| `tokens_valid_after` | É o *security stamp* do byteflow, e o código dele documenta o preço: *"Costs one user lookup per protected request"*. Isso é exatamente a **Opção B que a decisão 11 descartou** (*"custa uma leitura por request autenticada"*). A decisão 11 escolheu manter o estado no refresh, não no access. Copiar a coluna contradiria a decisão 11 em silêncio. |
| `email_verified_at` | Verificação de e-mail está em `DECISIONS.md` §6 como escopo de produto **ainda não decidido** (implica provedor de e-mail). Coluna sem código que a toque é schema morto. |
| `first_name` / `last_name` | Este projeto é module-first: o módulo `auth` deveria possuir só o que autentica. Nome de pessoa é assunto de perfil. O byteflow pôde juntar porque tem um `packages/database` único, não módulos com dono. |

E a tabela `refresh_tokens`, embora a decisão 11 já a especifique por inteiro,
fica para a fatia que construir a rotação: o formato dela (`family_id`,
`replaced_by` como self-FK, índice parcial de sessões ativas) fica mais honesto
de decidir junto com a lógica que o usa. Com forward-only, entra como `0001`
sem custo.

### Consequência registrada

Como não há `tokens_valid_after`, **troca de senha não invalida o access token
imediatamente** neste projeto — vale até o TTL de 1h. Isso não é um esquecimento:
é o trade-off que a decisão 11 aceitou explicitamente (*"a latência de revogação
é o TTL do access"*). Se algum dia se quiser revogação instantânea, o custo é a
leitura por request que a decisão 11 recusou, e a decisão precisa ser reaberta —
não a tabela, remendada.

## 8. O que o teste prova

Um `.spec.ts` em `tests/integration/`, operando direto pelo handle do Drizzle
(não há repositório ainda):

1. **Roundtrip** — insert seguido de select devolve a linha.
2. **O índice funcional funciona** — inserir `joao@x.com` e depois
   `JOAO@x.com` viola a constraint. Esta é a única coisa não trivial da
   migration, e é a que um `citext` esquecido ou um `lower()` fora do índice
   quebraria em silêncio.
3. **Os defaults preenchem** — inserindo apenas `email` e `password_hash`, o
   `id` e os dois timestamps chegam preenchidos. É o teste do defense-in-depth
   descrito na §3.

O item 2 é o que transforma "só schema + migration" numa fatia com prova real.

## 9. Critério de aceite

- [ ] `pnpm db:generate` produz `drizzle/0000_*.sql`, e o arquivo está commitado.
- [ ] `pnpm db:migrate` aplica a migration num banco limpo.
- [ ] `pnpm test:integration` passa **a partir de um banco de teste recém-criado**,
      sem nenhum passo manual — é a prova de que o `globalSetup` funciona.
- [ ] O teste do índice funcional (§8, item 2) falha se o `lower()` for removido
      do índice. Verificar removendo, rodando e restaurando.
- [ ] `pnpm lint`, `pnpm typecheck` e `pnpm build` verdes.
- [ ] A `TEST_DATABASE_URL` aparece uma única vez fora do `ci.yml`.

## 10. Pendência de manutenção detectada

O Node local é `v24.16.0`, mas `.nvmrc` pede `24.19.0` e `engines` exige
`>=24.19.0`. Não bloqueia esta fatia e não é tratado aqui, mas fica registrado.

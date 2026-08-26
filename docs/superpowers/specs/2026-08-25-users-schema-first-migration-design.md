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
  suíte de integração (ver §7).
- Um teste de integração que prova a migration.
- Uma exceção na `CLAUDE.md` para nomes em arquivo de schema (ver §6).
- A regra de posse de tabela e de foreign key entre módulos, registrada antes de
  existir um segundo módulo para exercê-la (ver §5).

**Não entra:**

- Entidade `User`, `Email` value object, `IUsersRepository`, mapper,
  `DrizzleUsersRepository`, use case, endpoint.
- `container.ts` e `config.ts` do módulo (decisões 08, 23, 14).
- `IClock` e `IIdGenerator` (decisão 21) — esta fatia apenas **assume** que
  existirão e desenha o schema de acordo (ver §3).
- A tabela `refresh_tokens` (ver §8).
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
| `crypto.randomUUID({ version: 7 })` no Node 24 | **Não lança erro** e devolve um **v4** — a opção é ignorada em silêncio. Verificado tanto no `v24.16.0` quanto no `v24.19.0`, que é a versão que o `engines` exige |
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

## 5. Posse de tabela e foreign key entre módulos

O schema mora **dentro do módulo**, como o glob da decisão 06 e o §2 do
`STRUCTURE.md` já previam. Isso não é neutro, e a consequência precisa estar
escrita antes de existir um segundo módulo.

### A regra, derivada da fronteira

O `STRUCTURE.md` §4, linha 3, permite que `module-infra` importe
`module-infra` **apenas do próprio módulo**. Aplicado a arquivo de schema:

| Foreign key | Situação |
|---|---|
| `refresh_tokens.user_id → users.id` (ambos em `auth`) | **Legal.** Mesmo módulo, `.references()` normal. |
| `orders.user_id → users.id` (`orders` → `auth`) | **Proibida.** Exigiria o schema de `orders` importar o de `auth`. |

Logo: **entre módulos, referencia-se por id, sem FK no banco.** A coluna é um
`uuid('user_id')` sem `.references()`, e a integridade fica na aplicação.

O `byteflow` faz o oposto — `refresh-tokens.ts` importa `users.ts` e declara
`.references(() => users.id, { onDelete: 'cascade' })`. Lá é legal, porque é um
`packages/database` único sem dono de módulo. Aqui, atravessando módulos, não é.

### Por que isso é a posição certa, e não uma limitação

Tabela em módulo **não** é tabela isolada no banco: todas caem no mesmo
`public`, na mesma timeline de migration, sob o mesmo lock. O que o layout
modular compra não é isolamento físico — é **quem tem o direito de escrever
nela**.

E a restrição resultante é a mesma que existiria se os módulos já fossem
serviços separados. É justamente isso que faz "módulo extraível" ser real em vez
de aspiracional: com FK física de `orders` para `users`, extrair `orders` vira
migração de dados, não `git mv`.

**Custo aceito:** sem integridade referencial no banco entre módulos. Uma linha
pode apontar para um registro apagado, e o Postgres não avisa. O comportamento
de `ON DELETE` passa a ser regra de aplicação ou evento de domínio, não
constraint.

### Colisão de nome de tabela — risco conhecido, não resolvido

Nada impede dois módulos declararem `users`. O `drizzle-kit` junta os globs e
gera a migration com as duas, e **o erro aparece no `db:migrate`, não no lint**.

Três saídas possíveis: disciplina, prefixo por módulo (`auth_users`), ou um
schema do Postgres por módulo (`pgSchema('auth')` → `auth.users`).

Decisão: **tudo em `public` por ora.** O `pgSchema` por módulo é a única saída
que torna a posse real no banco e faz o join cross-módulo ficar visível no SQL,
mas cobra atrito em toda query e em todo tooling. Como `ALTER TABLE ... SET
SCHEMA` é barato, adiar custa pouco — fica documentado como a saída se colisão
ou isolamento real virarem problema concreto.

## 6. Exceção de nomes na `CLAUDE.md`

A regra de no-magic-strings é aplicada estritamente neste repositório — em
`src/infra/http/endpoints/health.ts` até `'/health'`, `'ok'` e `'up'` são
constantes. Aplicá-la a nome de tabela e de coluna produziria sete constantes
usadas uma vez cada, dentro do arquivo que **é** a declaração desses nomes.

Decisão: a `CLAUDE.md` ganha uma exceção explícita para
`src/modules/*/infra/drizzle/schema.ts`, cobrindo **apenas** os nomes de tabela,
coluna e índice. Qualquer outro literal nesses arquivos segue a regra.

Registrado como decisão explícita, e não como desvio silencioso, porque vale
para todo módulo futuro.

## 7. Migration, e o furo que ela abre no fluxo local

`pnpm db:generate` produz `drizzle/<timestamp>_<nome>/migration.sql` (mais
`snapshot.json` na mesma pasta), que é **commitada**. O `drizzle-kit` na versão
usada aqui (`1.0.0-rc.4`) escreve uma pasta por migration — o formato
`folder-v3` do próprio `drizzle-kit`, sucessor do `0000_*.sql` plano com
`meta/` — então não há `0000_*.sql`. Forward-only, sem `down` (R4).

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

## 8. O que ficou de fora, e por quê

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

## 9. O que o teste prova

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

## 10. Critério de aceite

- [ ] `pnpm db:generate` produz `drizzle/<timestamp>_<nome>/migration.sql`, e a
      pasta está commitada.
- [ ] `pnpm db:migrate` aplica a migration num banco limpo.
- [ ] `pnpm test:integration` passa **a partir de um banco de teste recém-criado**,
      sem nenhum passo manual — é a prova de que o `globalSetup` funciona.
- [ ] O teste do índice funcional (§9, item 2) falha se o `lower()` for removido
      do índice. Verificar removendo, rodando e restaurando.
- [ ] `pnpm lint`, `pnpm typecheck` e `pnpm build` verdes.
- [ ] A `TEST_DATABASE_URL` aparece uma única vez fora do `ci.yml`.

## 11. Pendência de manutenção detectada

O Node ativo por padrão na máquina é `v24.16.0`, mas `.nvmrc` pede `24.19.0` e
`engines` exige `>=24.19.0`. Isso **bloqueia**: o `pnpm` recusa qualquer script
com `Your Node version is incompatible with ... Expected version: >=24.19.0
<25. Got: v24.16.0`.

A `v24.19.0` já está instalada via `fnm` — só não é a default. Antes de executar
o plano, ative-a (`fnm use`, que lê o `.nvmrc`). Não há nada a corrigir no
repositório; a divergência é de ambiente local.

---

## 12. Revisão pós-implementação — nome e organização dos arquivos de schema

Registrado depois da implementação, sem reescrever as seções acima: elas
descrevem o desenho no momento em que foi aprovado, e apagar isso esconderia a
mudança.

O desenho previa **um `schema.ts` por módulo**, com todas as tabelas dentro —
o que o `STRUCTURE.md` §2 e o `DECISIONS.md` §5 prescreviam. Ao revisar o
resultado, a pergunta que derrubou isso foi: *e quando o módulo tiver várias
tabelas, como elas se chamam?*

**Decidido: `infra/drizzle/schema/`, um arquivo por tabela, nomeado pela
tabela** — `users.ts`, depois `refresh-tokens.ts`. O diretório já diz "schema do
Drizzle", então o nome do arquivo não repete.

Razão: o projeto já tem convenção forte de **um conceito por arquivo** — decisão
03 ("um arquivo por endpoint") e §9 do `STRUCTURE.md` ("use case, um por
arquivo"). Tabela ser a exceção destoava. O `byteflow`, com quatro módulos
rodando, separa da mesma forma.

**Argumento contra, que perdeu mas é bom:** tabelas de um módulo são um grafo
conectado — `refresh_tokens` não significa nada sem `users`, nascem na mesma
migration e referenciam uma à outra. Vê-las juntas tem valor que use cases
independentes não têm. Perdeu porque `drizzle/` também acumula mapper e
repositório por tabela; com quatro tabelas seriam treze arquivos no mesmo nível.

**O que mudou junto:**

- `drizzle.config.ts` — glob passa a `./src/modules/*/infra/drizzle/schema/*.ts`.
- `CLAUDE.md` — a exceção de magic strings estava escopada no nome literal
  `schema.ts` e **deixaria de cobrir o arquivo**; reescopada para `schema/*.ts`.
- `ARCHITECTURE.md` §2, §3, §6 e o `STRUCTURE.md`/`DECISIONS.md` locais.

**Custo verificado como zero:** `pnpm db:generate` após a mudança respondeu
`No schema changes, nothing to migrate`, e o `md5sum` do `migration.sql` ficou
idêntico. O `snapshot.json` guarda definição de tabela, não caminho de arquivo.

**Ressalva para o futuro:** o glob `schema/*.ts` casaria também com um
`index.ts` de barrel, registrando cada tabela duas vezes. Se a superfície
pública do módulo (`STRUCTURE.md` §11) trouxer barrels, este glob precisa ser
revisto.

# Decisões de Arquitetura — API Clean Platform

> **Status:** em brainstorming. Documento vivo.
> **Última atualização:** 2026-08-20

Registro das decisões tomadas e, principalmente, **do porquê**. O objetivo é não
re-litigar escolha já fechada e não perder o raciocínio que levou a ela.

---

## 1. Contexto do projeto

**O que é:** um boilerplate de API em Node.js + TypeScript que servirá de base
para **múltiplos aplicativos**. A base entrega pré-configurado tudo que todo app
vai precisar: estrutura de código, banco, autenticação, Docker, CI e a infra
transversal (config, logging, tratamento de erro).

**O que isso implica no critério de decisão** — e vale explicitar, porque mudou
várias escolhas abaixo:

- Toda decisão é **multiplicada por N apps**. Um guard-rail fraco não erra uma
  vez, erra em todo app derivado.
- Os apps serão construídos por **devs de senioridade variada**. Ferramenta
  difícil de usar errado vale mais que ferramenta poderosa.
- O boilerplate é **artefato didático**: times copiam a forma que encontram.
  A estrutura ensina, querendo ou não.
- Vida longa. Dívida técnica assumida no dia 1 é herdada por todos.

**Escopo do primeiro corte:** apenas o módulo `auth`. O módulo `products` que
aparece no `ARCHITECTURE.md` é ilustração descartável.

### Roteiro do desenho

O pedido inicial ("banco, CI, Docker, auth e tudo que a base precisar") reúne
subsistemas relativamente independentes. Foram separados para que a discussão não
ficasse rasa em tudo, e são atacados nesta ordem:

| Bloco | Assunto | Situação |
|-------|---------|----------|
| a | Estrutura de código e camadas | ✅ fechado — decisões 01, 02, 03, 10 |
| b | Stack técnica (framework, ORM, banco) | ✅ fechado — decisões 04, 05, 06, 07 |
| c | Autenticação | ✅ fechado — decisões 11, 12 (RBAC segue em aberto) |
| d | Docker e ambiente de desenvolvimento | ✅ fechado — decisão 16 |
| e | CI | ✅ fechado — decisão 17 |
| f | Infra transversal (config, logging, erro) | ✅ fechado — decisões 13, 14, 15 |

(a) e (b) vieram primeiro porque todo o resto depende dessas escolhas. A DI
(decisão 08) e testes (09) foram resolvidos junto por serem pré-requisito de (c).

---

## 2. Decisões fechadas

| #  | Tema | Decisão |
|----|------|---------|
| 01 | Organização de pastas | Module-first |
| 02 | Camadas dentro do módulo | Achatado + `infra/` separado |
| 03 | Organização HTTP | `endpoints/` — 1 arquivo = schema + handler + rota |
| 04 | Framework HTTP | Fastify 5 |
| 05 | Banco | PostgreSQL |
| 06 | Acesso a dados | Drizzle |
| 07 | Versão do Drizzle | Pin exato em `1.0.0-rc.4` (orm + kit) |
| 08 | Injeção de dependência | Container manual tipado, factory por módulo |
| 09 | Testes | Unit colocado · integração em pasta separada |
| 10 | Entrypoints | `main/` — http, worker e cron compartilham o grafo |
| 11 | Autenticação | Access JWT 1h + refresh opaco rotativo com janela de graça |
| 12 | Transporte do token | Bearer na API; cookie `httpOnly` só no `/auth/refresh` |
| 13 | Tratamento de erro | Taxonomia semântica na camada pura + handler global |
| 14 | Variáveis de ambiente | Módulo declara o schema; boot faz merge e valida |
| 15 | Logging e correlação | Use case não loga; `traceId` ambiente via AsyncLocalStorage |
| 16 | Docker | Compose só para infra; aplicação roda no host em dev |
| 17 | CI e banco de teste | GitHub Actions; integração em banco `app_test` |
| 18 | Lint de fronteira | `dependency-cruiser` (revisada) |
| 19 | Path alias e build | Subpath imports do Node; build é `tsc` puro |
| 20 | Mappers | Funções puras em `infra/`, uma por entidade |
| 21 | Providers e relógio | Contrato no puro; implementação em `infra/providers/` |
| 22 | Atomicidade | Unit of Work explícito, injetado só em quem precisa |
| 23 | Transporte do container | Plugin do módulo recebe **a fatia dele** por opção |
| 24 | Posse de tabela e FK entre módulos | Schema mora no módulo; FK só dentro do módulo |
| 25 | Contrato do `register` | `202` sempre, sem corpo — quebra deliberada do `201`/`409` publicado |
| 26 | Backfill de `email_verified_at` | Nenhum; ressalva normativa para apps derivados em produção |
| 27 | Conta nasce na confirmação | `register` grava pendente sem senha; `email/verify` cria a conta com a senha daquele request |
| 28 | Exceção pontual a R4 | Migration de `email_verification_tokens` apagada; não se repete |
| 29 | Recuperação de senha | `forgot`/`reset` com token opaco de 256 bits, upsert com cooldown na cláusula `WHERE` |
| 30 | Cron / poda | `cron.ts` one-shot + scheduler externo; registry de jobs por módulo; poda com janela de retenção por tabela |
| 31 | Login com Google | Client-driven, verificação de ID token, sem merge silencioso |
| 32 | Seed de dev | Cenários por módulo fora do container; runner em `main/`; `wipe` por namespace; só banco local |
| 33 | Outbox transacional | Escopado aos três avisos pós-commit; estado por timestamp nulável; retry com teto simples (sem backoff explícito); tabela no módulo `auth` |

---

### 01 — Module-first em vez de layer-first

Módulo é a unidade de organização; as camadas vivem dentro dele.

**Motivo:** cada app derivado vai **adicionar** módulos, e o trabalho acontece
módulo a módulo. Em layer-first, adicionar uma feature toca 3-4 pastas distantes
na árvore; em module-first, uma subárvore. Extrair um módulo para outro serviço
vira `git mv` em vez de caçar pedaços em quatro lugares. E módulo que um app
precisa e outro não pode ser copiado ou deletado como pasta.

**Descartado — layer-first** (o que o `ARCHITECTURE.md` descrevia originalmente): o lint da
regra de dependência é mais trivial e a árvore ensina Clean Architecture de cara,
mas o custo diário de espalhar cada feature por quatro pastas não compensa, e com
15+ módulos cada camada vira scroll infinito.

> ✅ **Resolvido em 2026-08-20:** o `ARCHITECTURE.md` foi reescrito e hoje
> descreve module-first, alinhado a esta decisão.

---

### 02 — Dentro do módulo: achatado, com `infra/` separado

```
modules/auth/
├── entities/            # puro
├── value-objects/       # puro
├── repositories/        # SÓ os contratos (puro)
├── use-cases/           # puro  (+ .spec.ts colocado)
├── dtos/
├── errors/
└── infra/               # tudo que toca o mundo externo
    ├── drizzle/
    └── http/
```

**Motivo:** a fronteira que importa na prática é **puro vs. toca o mundo
externo** — é ela que quebra em code review e é ela que o lint precisa pegar.
A divisão `domain/` vs `application/` não precisa de pasta pai: `entities/` e
`use-cases/` **já dizem qual camada são**; o pai só repetiria o nome. Menos
profundidade no caminho diário, e a inversão de dependência continua visível.

**Descartado — camadas explícitas** (`domain/application/infra` dentro do
módulo): a arquitetura fica ilegal de ignorar, o que é um argumento real para um
artefato didático. Perdeu porque o `ARCHITECTURE.md` já faz esse trabalho de
ensino, e porque a regra vai ser enforçada por lint de qualquer forma — se o lint
garante, a árvore não precisa garantir também.

**Descartado — achatado puro** (sem `infra/`): deixaria contrato e implementação
na mesma pasta (`users-repository.ts` ao lado de `drizzle-users-repository.ts`),
parecendo pares. Não são pares: um é a abstração de que o use case depende, o
outro é o detalhe substituível. Esconde justamente a inversão de dependência.

#### Regra de fronteira — enunciado completo

> ⚠️ A primeira redação desta regra — *"nada fora de `modules/*/infra/**` pode
> importar de `modules/*/infra/**`"* — **estava errada nas duas direções**, o que
> a auditoria de 2026-08-20 expôs:
>
> - **Não cobria o `src/infra/` global.** Um use case podia importar
>   `#infra/config/env` ou o logger sem violar nada — exatamente o que as decisões
>   14 e 15 proíbem.
> - **Proibia três coisas que o desenho exige:** `modules/*/container.ts` (que
>   por definição instancia o concreto), `main/**` e os `.spec.ts` colocados. Quem
>   configurasse o lint a partir dela quebraria o CI em todo módulo.

Enunciado correto, por tipo de elemento:

| Elemento | Padrão | Pode importar |
|---|---|---|
| `pure` | `src/modules/*/{entities,value-objects,repositories,providers,use-cases,dtos,errors}/**` · `src/modules/*/config.ts` · `src/shared/**` | só `pure` |
| `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · o `module-infra` **do próprio módulo** |
| `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| `composition` | `src/modules/*/container.ts` · `src/main/**` | tudo |
| `test` | `**/*.spec.ts` · `tests/**` | tudo |

**`composition` e `test` são exceções deliberadas, não brechas.** O composition
root existe justamente para conhecer o concreto (decisão 08), e o teste unitário
precisa alcançar o repositório in-memory (decisão 09). Deixá-las implícitas é o
que produz "exceção não documentada" e esvazia a regra.

A linha `module-infra` também resolve o cruzamento entre módulos: o `infra/` de um
módulo não alcança o `infra/` de outro — que é a metade de R5 que a redação antiga
não cobria. A exceção conhecida é `ensure-authenticated`, enquanto a superfície
pública do módulo não estiver definida (seção 6).

Opcionalmente, `entities/**` não importa `use-cases/**` — **não adotada**.

---

### 03 — HTTP: um arquivo por endpoint

```
modules/auth/infra/http/
├── endpoints/
│   ├── authenticate.ts      # schema + handler + rota, juntos
│   └── register.ts
├── middlewares/
└── routes.ts                # agregador fino
```

**Motivo:** rota e handler são 1:1 e mudam **sempre juntos**. O padrão clássico
(`controllers/` + `routes.ts` separado) recria o problema do layer-first um nível
abaixo — cada endpoint novo passa a tocar dois arquivos distantes. Endpoint novo
aqui é criar um arquivo e registrar uma linha.

**Nota de nomenclatura:** com a rota no mesmo arquivo, "controller" fica
impreciso — o arquivo é o adaptador HTTP inteiro. Sufixo `.controller` foi
dropado.

**Descartado — pasta por endpoint** (`endpoints/authenticate/` com route, schema
e controller separados): granularidade boa e caberia o e2e junto, mas é cerimônia
pesada demais para um POST simples.

---

### 04 — Fastify

**Motivo decisivo — encaixe estrutural:** o sistema de **plugins com
encapsulamento** do Fastify mapeia quase 1:1 no módulo escolhido em (01). Cada
módulo exporta um plugin registrado com prefixo e escopo próprios, o que dá a
fronteira de módulo **em runtime**, não só na árvore de pastas. Somando: validação
e serialização por schema nativas (a serialização é ganho real de performance) e
ecossistema `@fastify/*` oficial e maduro (jwt, cookie, helmet, rate-limit,
multipart, swagger).

**Descartado — Express:** dominado em 2026. Sem validação nativa, tipos via
DefinitelyTyped, o mais lento dos candidatos, ecossistema de middleware
envelhecido. Ganha só em familiaridade, e isso não paga num boilerplate de vida
longa.

**Descartado — Hono:** melhor inferência de tipos do grupo, client RPC tipado de
graça e portabilidade Web Standards (Node, Bun, Workers, edge). Perdeu porque a
portabilidade é benefício que este projeto provavelmente nunca usa (é backend com
banco e Docker), e o ecossistema Node é menor.

**Descartado — NestJS:** resolve DI, módulos, config e testing prontos, que é
exatamente a dor de um boilerplate multi-app, e é a escolha "enterprise" com boa
documentação. Rejeitado por dois motivos: traz `reflect-metadata` e decorators
legados; e principalmente **adotar Nest descartaria as decisões 01, 02, 03 e 08**
— module-first achatado, `endpoints/` e composition root explícito não são o jeito
Nest. Escolher Nest é adotar as convenções dele, e isso foi uma decisão
consciente de não tomar.

---

### 05 — PostgreSQL

Padrão para API transacional; tem tudo que os apps vão precisar (JSONB,
full-text, extensões, particionamento) e todo provider gerenciado suporta.
Assumido sem debate.

> ❓ **Pergunta em aberto:** algum dos apps-alvo já tem restrição de banco
> imposta (cliente, infra existente, contrato)? Foi levantada e não respondida.

---

### 06 — Drizzle em vez de Prisma

**Enquadramento:** como os repositórios estão atrás de interfaces, o ORM é um
**detalhe substituível por construção**. Isso tira lock-in da mesa e deixa a
decisão em DX e custo operacional.

**Motivo:** o schema do Drizzle é TypeScript, então ele **quebra por módulo** —
cada módulo declara suas tabelas em `modules/*/infra/drizzle/schema/*.ts` e o
`drizzle.config.ts` agrega via glob. O Prisma exigiria um `schema.prisma` global,
um arquivo fora de qualquer módulo listando tabelas de todos eles, furando a
encapsulação de (01). Somando: zero codegen, imagem Docker enxuta, SQL
transparente e nenhuma parede de "como expresso essa query".

**Sobre o Prisma, para registro** (a comparação mudou recentemente e a maior parte
do que se lê na internet está desatualizada): no Prisma 7, `@prisma/client` tem
uma única dependência (`@prisma/client-runtime-utils`) — **o binário Rust vive
agora só na CLI**, usada em migration e introspection. Toda a dor histórica de
Docker (`binaryTargets`, `linux-musl-openssl-3.0.x`, imagem gorda, cold start)
não se aplica mais. O Prisma continua com a melhor ferramenta de migration do
ecossistema (`migrate dev` vs `migrate deploy`, detecção de drift contra shadow
database, recusa de aplicar sobre schema divergente), e esse era o argumento
mais forte a favor dele para um boilerplate.

**Custo aceito nos dois casos:** como o repositório devolve entidade de domínio e
não a row do banco, são necessários **mappers** (`UserMapper.toDomain(row)`). É o
preço da Clean Architecture, não do ORM.

**Reversibilidade:** trocar Drizzle por outra coisa significa reescrever
`modules/*/infra/drizzle/` e o schema. `entities/`, `use-cases/`, `repositories/`
(contratos), `dtos/`, `errors/`, `endpoints/` e todos os testes unitários ficam
intactos. Não é porta de mão única.

---

### 07 — Pin exato em `1.0.0-rc.4`

**Dados coletados em 2026-08-19:**

```
drizzle-orm  latest → 0.45.2       (2026-03-27, branch parada há ~5 meses)
drizzle-orm  rc     → 1.0.0-rc.4   ← canal RC oficial dos mantenedores
drizzle-kit  rc     → 1.0.0-rc.4

tags limpas 1.0 publicadas: rc.1, rc.2, rc.3, rc.4 — e nada além

rc.5 existe SÓ como snapshot de branch:
  orm  rc5 → 1.0.0-rc.5-169397b
  kit  rc5 → 1.0.0-rc.5-ab785fc    ← hash DIFERENTE do orm
```

**Motivo de ir no RC e não no estável:** o branch estável está congelado desde
março; todo o desenvolvimento migrou para a linha 1.0, que itera com cadência
firme (rc.3 em maio, rc.4 em junho, snapshots rc.5 em agosto). "0.45.2 estável"
não é a opção conservadora que o número sugere — é uma branch morta. Nascer nela
é começar devendo uma migração de major, **multiplicada por todo app derivado**.

**Motivo de rc.4 e não rc.5:** o rc.5 nunca foi cortado como release, só como
build de branch — e os snapshots de `orm` e `kit` apontam para commits
diferentes. `drizzle-orm` e `drizzle-kit` precisam andar em **lockstep**.

**Mitigações:**
1. Pin **exato**, sem caret. RC não respeita semver.
2. Superfície confinada a `modules/*/infra/drizzle/`, `infra/database/` e
   `drizzle.config.ts`. Subir para o GA vira mudança contida.
3. Os testes de integração (decisão 09) são a rede que torna depender de um RC
   aceitável: bump com suíte batendo em Postgres real é decisão de 10 minutos.

**Riscos conhecidos do roadmap v1** e o que fazemos a respeito — ver seção 4.

**Leitura de prazo:** não agendar nada em cima do GA. Foram 23 betas e 4 RCs
cortados (mais snapshots de branch rotulados rc.5), e
"MSSQL support" ainda aparece *antes* do marcador de release stream. A direção é
certa; a data, não.

---

### 08 — Container manual tipado

Cada módulo exporta a factory do seu container; `main/` compõe todos.

```ts
// modules/auth/container.ts
export function makeAuthContainer(db: Database) {
  const usersRepository = new DrizzleUsersRepository(db)
  const hashProvider    = new Argon2HashProvider()

  return {
    authenticateUser: new AuthenticateUserUseCase(usersRepository, hashProvider),
    registerUser:     new RegisterUserUseCase(usersRepository, hashProvider),
  }
}

// main/container.ts
export function makeContainer(db: Database) {
  return { auth: makeAuthContainer(db) }
}
export type Container = ReturnType<typeof makeContainer>
```

**Motivo:** tipagem 100% inferida sem string key, o grafo inteiro legível em dois
arquivos, e o mesmo grafo serve os três entrypoints. Num boilerplate, wiring
legível é feature — outros times vão ler isso.

**Sobre `new` e performance** (dúvida levantada e resolvida): instanciar classe no
V8 custa nanosegundos, contra milissegundos de rede e banco por request — é ruído
estatístico. O problema do `new` no controller nunca foi performance, e sim
**acoplamento**: quem monta passa a conhecer as implementações concretas e a
interface vira decoração. Objeto stateless (repository, provider) é singleton no
container.

**Descartado — `decorate` do Fastify como mecanismo de DI:** eliminado pelo
requisito de múltiplos entrypoints (10). Amarraria o wiring de domínio ao
framework HTTP, deixando worker e cron sem grafo.

**Descartado — awilix:** escopo por request nativo (útil para transaction context
e correlation id) e lifetimes explícitos. Perdeu por enfraquecer a tipagem (Cradle
escrito à mão), deixar erro de registro só aparecer em runtime, e adicionar
dependência no core do boilerplate.

**Descartado — factory por use case** (`make-authenticate-user.ts`, estilo mais
difundido em Clean Architecture Node): simples e lazy, mas gera um arquivo por use
case, não dá visão única do grafo, e cada factory acaba refazendo o `db` ou
dependendo de import global.

**Em aberto:** escopo por request (transaction context, correlation id) será
resolvido nas decisões 15 e 22: `traceId` fica ambiente no AsyncLocalStorage e
transação fica explícita via Unit of Work. Contexto propagado à mão em `execute()`
foi avaliado e descartado na decisão 15.

---

### 09 — Estratégia de testes

- **Unit:** colocado ao lado do arquivo (`authenticate-user.spec.ts`). Mantém o
  teste visível e barato de rodar; sem I/O, roda em milissegundos.
- **Integração:** pasta separada. Precisa de setup próprio (banco de teste,
  container, seed, teardown) e roda em segundos — perfil de execução diferente,
  provavelmente dois comandos e duas configs.
- Integração cobre os casos onde se quer garantia extra de qualidade e segurança,
  não tudo.

O boilerplate precisa de repositórios **in-memory** de qualquer forma, para os
testes unitários dos use cases.

---

### 10 — `main/` com múltiplos entrypoints

O boilerplate prevê que um app derivado instancie mais de um processo (HTTP
server, worker de fila, cron). Todos compartilham o mesmo composition root (08).
Esse requisito foi o que eliminou o `decorate` do Fastify como DI.

---

### 11 — Auth: access JWT curto + refresh opaco rotativo

> **Emendada em 2026-09-01**, pela fatia que a implementou. Quatro pontos da
> mecânica que o esboço não fixava, e um deles é correção de segurança.
>
> **`replaced_by` é o discriminante entre rotação e logout**, e é o que impede a
> janela de graça de virar bypass da revogação explícita. Um token revogado por
> logout não tem sucessor; sem essa guarda, deslogar e dar refresh dentro de 30
> segundos devolveria um par funcionando.
>
> **A ordem de checagem é normativa: revogado ANTES de expirado.** O cliente que
> rotaciona um segundo antes de `expires_at` e perde a resposta chega com um
> token revogado *e* expirado; checando expiração primeiro ele leva 401 — o
> logout aleatório que a janela existe para eliminar, reaparecendo numa borda
> estreita. O efeito colateral vai para o lado certo: token já gasto que
> reaparece depois de expirar dispara detecção de reuso, em vez de um 401 mudo.
>
> **A janela não desliza.** `revoked_at` não é reescrito, então o token morre 30
> segundos depois da primeira rotação por mais retries que cheguem.
>
> **`family_id` não pode ganhar índice único parcial**, e o motivo não é o que
> esta emenda dizia originalmente. Não é que a família tenha vários tokens
> ativos — a emenda seguinte fechou isso. É que a rotação normal **precisa
> inserir o sucessor antes** de poder gravar o `replaced_by` dele, então os dois
> coexistem por dois statements dentro de **toda** transação de rotação. O
> invariante vale no commit, nunca no meio.
>
> **Emendada em 2026-09-01, segunda vez.** Dentro da janela, o par novo é
> emitido **e o sucessor anterior é revogado** — sem `replaced_by`, para que
> apresentá-lo caia em detecção de reuso e não seja perdoado de novo.
>
> Fecha uma bifurcação que a redação anterior permitia: um token roubado
> reapresentado dentro dos 30s ganhava uma cadeia viva paralela na mesma
> família; a partir daí nenhum dos dois lados jamais apresentava token gasto, e
> **a detecção nunca mais disparava para aquela família** — sessão roubada
> sobrevivendo à própria detecção, por 60 dias deslizantes.
>
> Não custa nada no caso que a janela existe para resolver: quando a resposta
> se perdeu no túnel, o sucessor revogado é justamente o que não chegou a
> ninguém.
>
> ⚠️ **Passa a exigir do cliente: refresh em single-flight.** Uma chamada por
> vez, e quem chegar depois espera o mesmo resultado. Dois refresh concorrentes
> com o mesmo token devolvem dois tokens diferentes e só o último emitido
> sobrevive — o cliente que guardar o outro é deslogado no refresh seguinte.
> É o que todo interceptor sério já faz; o que muda é que antes um cliente
> desleixado sobrevivia por acidente, porque os dois tokens funcionavam.
>
> A invariante resultante é **no máximo um token vivo por família no commit** —
> nunca dentro da transação, porque a rotação normal precisa inserir o sucessor
> antes de poder gravar o `replaced_by` dele. Índice único parcial em
> `family_id` é impossível por construção.

> ⚠️ **A revogação da família tem de COMMITAR antes de o erro ser lançado.**
> Revogar e lançar de dentro da transação faz o rollback desfazer a revogação:
> a detecção dispara, responde 401, e a família roubada continua viva. O reuso
> sai da transação como **dado**, e o `throw` acontece depois do commit. Isso
> foi encontrado pelo teste de integração, não pela revisão — desenho completo
> em [`specs/2026-08-31-refresh-token-design.md`](superpowers/specs/2026-08-31-refresh-token-design.md) §4.2.

> **Emendada em 2026-09-03, pela fatia 9.** A troca de senha é o primeiro
> consumidor real da revogação: ela revoga **todas** as famílias e emite um par
> novo para o aparelho que trocou, na mesma transação e nessa ordem — a
> revogação antes do insert, porque `revokeAllForUser` apanha toda linha viva do
> usuário e pegaria o token recém-inserido.
>
> Preservar a sessão atual foi considerado e descartado. O argumento de que
> preservá-la protegeria o atacante **não separa os desenhos**: quem trocou a
> senha a conhece, e faz login de novo em qualquer um deles. A escolha foi de UX
> e de superfície de contrato.
>
> Senha atual errada responde **422**, não 401, e a razão é o cliente: um
> interceptor que lê 401 como "access token venceu" refrescaria um token bom,
> repetiria a request e deslogaria o usuário por um erro de digitação.

```
access   JWT, 1h, transporte Bearer
refresh  token opaco no banco, 60d deslizante, rotativo a cada uso
         + janela de graça de 30s   (anti-retry)
         + detecção de reuso        -> revoga a família inteira
storage  Keychain (iOS) / Keystore (Android) — responsabilidade do app
hash     argon2id (ver seção 3)
```

```
tabela refresh_tokens
  id · user_id · token_hash · family_id
  expires_at · revoked_at · replaced_by · created_at

  token_hash = sha256(token)  -- determinístico e INDEXÁVEL, índice único
```

> **`token_hash` é SHA-256, não argon2.** O `IHashProvider` (argon2id) serve
> **apenas para senha de usuário**. Aplicá-lo ao refresh tornaria a busca
> impossível — argon2 usa salt aleatório, então `WHERE token_hash = ?` nunca
> casaria e a implementação degeneraria em varrer a tabela rodando argon2 por
> linha: vetor de DoS de CPU num endpoint de alta frequência. Token opaco já tem
> entropia alta (32 bytes de `crypto.randomBytes`); o que ele precisa é de digest
> determinístico, não de key stretching.

**O que a janela de graça devolve.** O refresh antigo que chega **dentro** dos 30s
é aceito mais uma vez e emite um **par novo na mesma família**, sem disparar
detecção de reuso. Fora da janela, é tratado como vazamento e revoga a família.

> Devolver "o mesmo par" seria impossível: só o hash é persistido, e o servidor
> não consegue reproduzir o token em claro que emitiu. A alternativa — cachear o
> par emitido por 30s — exigiria Redis (cache em memória falha com N instâncias,
> justamente no retry) e guardaria segredo em claro, com exposição equivalente.

**A rotação inteira acontece dentro de `uow.run`, com trava de linha**
(`SELECT ... FOR UPDATE` na linha atual). Sem isso, dois refresh simultâneos com o
mesmo token passam os dois e **a detecção de reuso nunca dispara** — o índice
único em `token_hash` é a segunda barreira.

> **Precisão de tempo, descoberta ao construir a tabela `users` (2026-08-25).**
> O Postgres guarda `timestamptz` em **microssegundos**; o `Date` do JS só tem
> **milissegundos**. Um valor gravado pelo default do banco (`now()`) e lido pela
> aplicação chega truncado: `…13.159767` vira `…13.159`.
>
> Isso importa aqui porque a janela de graça compara instantes, e um lado pode
> vir do banco enquanto o outro vem do `IClock`. A 30 segundos de escala a
> diferença sub-milissegundo não muda veredito nenhum — mas ela existe, e um
> teste de fronteira que a encontre sem saber de onde veio custa horas.
>
> A mitigação já está no desenho: com a R7, `IClock` é a fonte de `expires_at`,
> `revoked_at` e `created_at`, e tudo é gravado com precisão de ms. A assimetria
> sobra só em linha escrita direto no banco. **Não use `defaultNow()` em coluna
> que a rotação compara** — deixe o `IClock` preencher.

**O que decidiu o desenho: revogação.** JWT stateless puro não revoga — usuário
trocou senha, admin baniu, logout em todos os dispositivos: nada disso funciona
até o token expirar sozinho. Todo app real precisa disso, então a pergunta nunca
foi *se* há estado no servidor, e sim **onde**. Aqui o estado fica no refresh, não
no access: a rota autenticada não toca o banco, e a revogação acontece no
refresh.

**Contexto que decidiu entre as opções: os apps-alvo são mobile.** Isso é o
padrão de mercado com folga — access JWT curto + refresh longo, Bearer, token em
armazenamento seguro do SO:

| Plataforma | Access token | Refresh |
|---|---|---|
| Firebase Auth | JWT, 1h | sim, SDK renova sozinho |
| Supabase | JWT, 1h (default) | sim, com rotação |
| AWS Cognito | JWT, 1h (default) | sim, até anos |
| Auth0 | JWT | sim, rotação + detecção de reuso |
| Clerk | JWT bem curto (~1min) | sessão longa |

App de celular fica logado por meses, o que exige um refresh longo de qualquer
forma. E a opção B colocaria uma leitura de banco em cada request de um cliente
que passa o dia em polling e sync de background — o pior lugar possível para I/O.

**Por que TTL de 1h e não 15min:** 15min é convenção web, de quando o token
ficava em `localStorage` exposto a XSS. Aqui o **access não é persistido em lugar
nenhum** — vive em memória nos dois tipos de cliente (decisão 12) e morre com o
processo, então a janela de roubo é a da sessão, não a do dispositivo. Quem vai
para o armazenamento seguro do SO é o **refresh**, e ele é opaco e revogável.
Risco menor, e 1h corta o tráfego de refresh em 4x. É o default de Firebase,
Supabase e Cognito.

**Por que a janela de graça — o detalhe que quebra em produção:**

> O celular manda o refresh, o servidor rotaciona e responde, **a resposta se
> perde** (túnel, elevador, troca de 4G para WiFi). O app faz retry com o token
> antigo. A detecção de reuso interpreta como token vazado e revoga a família
> inteira: **o usuário é deslogado do nada.**

Isso acontece o tempo todo em mobile. A correção é aceitar o refresh antigo por
~30s após a rotação, devolvendo o mesmo par novo. O Auth0 tem exatamente esse
parâmetro (*reuse interval*). Sem a janela, rotação em app mobile gera logout
aleatório — e é um bug infernal de reproduzir.

**Consequência a considerar quando RBAC for decidido:** se roles/permissões
forem para dentro do JWT, mudança de permissão só vale no próximo refresh — a
mesma janela de 1h, agora valendo para autorização, não só autenticação.

**Trade-off aceito:** a latência de revogação é o TTL do access (1h). B teria
latência zero, mas ao custo de uma leitura por request. **É o mesmo trade-off
deslocado** — A paga no refresh, B paga em toda request — e mobile empurra o
custo para o refresh.

**Complexidade aceita:** é a maior das três opções. Rotação + família + detecção
de reuso + janela de graça precisam estar corretos, e errar a rotação é bug de
segurança sutil. Justifica cobertura por teste de integração (decisão 09).

<details>
<summary><b>Descartado — Opção B</b>, sessão opaca no banco</summary>

```
token = opaco (random 256 bits), só um ponteiro
toda request -> SELECT na sessão -> valida

tabela sessions
  id · user_id · token_hash · expires_at · revoked_at
  user_agent · ip · last_seen_at

revogação: INSTANTÂNEA        janela de exposição: ZERO
```

O mais simples de auditar, revogação imediata, e "dispositivos ativos" sai de
graça. **Não é uma opção fringe** — é o default de stacks web modernas
(better-auth, Lucia, e o padrão de Rails/Django/Laravel), e existe um movimento
legítimo de "pare de usar JWT para sessão". Perdeu porque esse debate é web-first:
custa uma leitura por request autenticada, pede Redis/cache antes do esperado, e
não serve se algum serviço precisar validar token sem acesso ao banco.
</details>

<details>
<summary><b>Descartado — Opção C</b>, JWT stateless puro</summary>

```
access e refresh ambos JWT, nada persistido
validação = verificar assinatura. só.

trocou senha   -> token velho SEGUE VALENDO
usuário banido -> SEGUE ENTRANDO
logout all     -> impossível
token vazado   -> válido até expirar
```

Zero infra e a melhor escala das três, mas sem revogação. A saída usual é uma
denylist — que é estado de novo, ou seja, reinventa a opção A pior feita. Retrofit
posterior é caro porque mexe em todo app já derivado do boilerplate.
</details>

Transporte: ver decisão 12.

---

### 12 — Transporte: Bearer na API, cookie `httpOnly` só no refresh

> **Emendada em 2026-09-01.** O `Path` do cookie passa de `/auth/refresh` para
> **`/auth`**. O valor estreito foi escrito antes de o `logout` ser desenhado, e
> com ele o browser **nunca manda o cookie para `/auth/logout`** — o logout por
> cookie seria impossível de implementar. O custo é o cookie trafegar também em
> `login` e `register`, que o ignoram; ele segue `HttpOnly`, `Secure` e
> `SameSite=Strict`, e `headers.cookie` já está no `REDACT_PATHS`.
>
> **O `login` ganha um campo `refreshTransport` (`body` | `cookie`, default
> `body`).** Ele é o único endpoint sem sinal de entrada para distinguir cliente
> mobile de web — todos os outros aprendem o canal do pedido que chegou.
> Registro honesto: **provedor de identidade nenhum faz isso.** Firebase,
> Supabase, Cognito e Auth0 respondem no body e deixam o cookie para um BFF. É a
> própria decisão 12 que exige o campo, ao servir os dois transportes de uma
> superfície só — configuração de processo não decide, já que os dois clientes
> chegam ao mesmo processo. Precedente de primeira parte: os endpoints de
> Identity do ASP.NET Core expõem `?useCookies=true`.
>
> **Medido:** o Safari recusa cookie `Secure` sobre `http://localhost`; Chrome e
> Firefox aceitam. O modo cookie não pode ser exercitado pelo `/docs` no Safari.
> O `Secure` continua incondicional mesmo assim — `NODE_ENV` tem
> `.default('development')`, então condicioná-lo mandaria cookie sem `Secure` em
> qualquer deploy que esquecesse a variável.

Há clientes web (painel admin, dashboard) além dos apps mobile, então os dois
transportes são necessários. Mas **não em partes iguais**:

```
                 mobile                        web (SPA / admin)
                 ------                        -----------------
access    Authorization: Bearer <jwt>    Authorization: Bearer <jwt>
          guardado em memória            guardado em MEMÓRIA (variável JS)

refresh   Keychain / Keystore            cookie httpOnly
          vai no body do                 o browser envia sozinho, e
          POST /auth/refresh             SÓ para POST /auth/refresh
```

```
Set-Cookie: refresh_token=<opaco>
  HttpOnly             JS não lê  -> XSS não rouba
  Secure               só HTTPS
  SameSite=Strict      não é enviado em request cross-site
  Path=/auth/refresh   só trafega para ESSE endpoint
  Max-Age=5184000      60d (alinhado à decisão 11)
```

**Motivo — o desenho colapsa o problema de CSRF em vez de administrá-lo.**
A alternativa óbvia (cookie para tudo, inclusive o access) colocaria **toda rota
mutante** sob risco de CSRF, exigindo token anti-CSRF em cada uma. Aqui não:

- Toda rota autenticada lê `Authorization`. Um site malicioso **não consegue
  forjar header** em request cross-site — então todas as rotas da API ficam
  imunes por construção, sem nenhum mecanismo anti-CSRF.
- O cookie existe só para `/auth/refresh`, e `SameSite=Strict` bloqueia cross-site
  justamente ali. A superfície de CSRF vira aproximadamente zero.
- Contra XSS o resultado é melhor que `localStorage`: o access vive em memória e
  morre no reload; o refresh é `httpOnly` e o JS não alcança.

**Benefício colateral:** a superfície da API é **idêntica** para mobile e web.
Só o endpoint de refresh muda de comportamento — lê o token do cookie ou do body,
conforme o cliente. Nenhum outro código precisa saber qual é o transporte, o que
torna "suportar os dois" quase de graça, como previsto na decisão 11.

**Descartado — cookie para tudo:** todas as rotas passariam a exigir proteção
anti-CSRF, e mobile precisaria de cookie jar, que não é idiomático.

**Descartado — `localStorage` no web:** XSS lê trivialmente, e o token persiste
entre sessões, ampliando a janela de roubo.

> ⚠️ **Restrição de deploy que isso impõe.** `SameSite` funciona por domínio
> registrável. `api.exemplo.com` + `app.exemplo.com` são **same-site** e o cookie
> flui normalmente. Se a API e o front ficarem em domínios registráveis diferentes
> (`meuapp.com` + `minhaapi.io`), o par vira **cross-site**: o cookie exigiria
> `SameSite=None; Secure`, o que reabre CSRF e passa a exigir token anti-CSRF
> explícito (double-submit) no endpoint de refresh.
> **Recomendação: manter API e front no mesmo domínio registrável.** O caminho
> cross-site deve ser suportado, mas documentado como o modo caro.

**Nota de CORS:** requisição cross-origin com credencial exige
`Access-Control-Allow-Credentials: true` e allowlist explícita de origem —
`*` é inválido nesse modo.

---

### 13 — Erros: taxonomia semântica + handler global

> **Emendada em 2026-08-30.** A taxonomia passou a ter **sete** categorias:
> nasceu `TransientError`, mapeada para `503` com `Retry-After`. Ela nomeia a
> falha em que nada do pedido está errado e repetir provavelmente resolve —
> deadlock é o caso canônico, e o Postgres mata uma das duas transações
> justamente para a outra passar.
>
> Não era representável pelas seis: não é `Conflict`, que descreve conflito de
> domínio ("e-mail já em uso") e não se resolve repetindo; e cair no ramo
> genérico responderia `500`, apagando a distinção entre "volte já já" e "seu
> pedido tem um defeito" — que é exatamente a distinção que o `code` público
> existe para dar ao cliente.
>
> É a única categoria que acrescenta header. Desenho em
> [`specs/2026-08-30-transient-failures-design.md`](superpowers/specs/2026-08-30-transient-failures-design.md) §6.

> **Emendada em 2026-09-04, pela fatia 10.** Ela precisou de duas categorias
> novas, cada uma resolvendo um confronto com uma decisão já tomada.
>
> **`EmailNotVerifiedError` → `ForbiddenError` → 403**, e não 401. A definição
> da tabela é "autenticado, sem permissão", e é literalmente o caso: a senha
> bateu, a identidade está provada, e o que falta é a permissão de entrar.
> Cogitado e descartado: 422, pela simetria com `InvalidCurrentPasswordError`
> logo abaixo. A simetria não se sustenta — o argumento que levou a fatia 9 a
> preferir 422 a 401 foi um interceptor mobile que lê 401 como "access token
> venceu", refresca um token perfeitamente bom e repete a chamada, deslogando o
> usuário quando o problema era outro. Em `change-password` esse token existe: é
> ele que autoriza a chamada, e é ele que o interceptor tentaria refrescar. Em
> login não há token nenhum ainda — nada para o interceptor refrescar, então o
> loop que motivou a fatia 9 não pode acontecer aqui. Sem essa pressão, vale o
> significado natural da tabela.
>
> **`EmailVerificationFailedError` → `BusinessRuleError` → 422.** Aqui a
> simetria com `InvalidCurrentPasswordError` é exata, não aparente: um segredo
> errado (o código de seis dígitos) apresentado por quem já se identificou (dono
> do endereço de e-mail). O corpo está bem formado — seis dígitos —, o que
> falhou é uma regra: código inexistente, expirado, tentativas esgotadas, código
> errado ou a corrida perdida para uma confirmação concorrente. Um erro só para
> as seis causas, pelo mesmo motivo do `throw` único de `login-user.ts`: ramos
> que nascem idênticos divergem na primeira manutenção — um ganha um log, outro
> uma mensagem — e o oráculo volta.

O problema: `InvalidCredentialsError` mora em `modules/auth/errors/`, camada
**pura**. Ela não pode saber que é um HTTP 401 — isso violaria a fronteira da
decisão 02. Mas alguém precisa traduzir.

A solução é uma taxonomia de erros **semântica, não protocolar**. "Não
encontrado" e "conflito" são conceitos legítimos de aplicação; existem igual num
worker ou num cron, onde HTTP não faz sentido nenhum.

```ts
// shared/errors/  — camada PURA, nenhuma menção a HTTP
export abstract class NotFoundError     extends AppError {}
export abstract class ConflictError     extends AppError {}
export abstract class UnauthorizedError extends AppError {}  // não autenticado
export abstract class ForbiddenError    extends AppError {}  // autenticado, sem permissão
export abstract class ValidationError   extends AppError {}
export abstract class BusinessRuleError extends AppError {}  // regra de negócio violada

// modules/auth/errors/
export class InvalidCredentialsError extends UnauthorizedError {
  constructor() { super('Credenciais inválidas') }
}
```

```ts
// infra/http/error-handler.ts — ÚNICO lugar do sistema que conhece status HTTP
app.setErrorHandler((err, req, reply) => {
  if (err instanceof NotFoundError)     return reply.status(404)...
  if (err instanceof ConflictError)     return reply.status(409)...
  if (err instanceof UnauthorizedError) return reply.status(401)...
  if (err instanceof ForbiddenError)    return reply.status(403)...
  if (err instanceof ValidationError)   return reply.status(400)...
  if (err instanceof BusinessRuleError) return reply.status(422)...

  // desconhecido -> 500, sem vazar nada
  req.log.error({ err }, 'unhandled error')
  return reply.status(500).send(/* corpo genérico */)
})
```

**Motivo:** a fronteira fica intacta e **o mapa não cresce com o número de
erros** — cem erros de domínio continuam caindo nas mesmas seis categorias. O use
case só faz `throw`, e o endpoint fica sem `try/catch`.

**Regra para erro inesperado:** qualquer coisa que não estenda `AppError` vira
500 com corpo genérico e **nada do interno vaza** (sem stack, sem mensagem de
driver). O log registra tudo, correlacionado — ver decisão de logging.

> ⚠️ **Falha de validação do Fastify NÃO é da taxonomia.** Verificado na
> auditoria de 2026-08-20: um corpo inválido chega ao handler como
> `Error` com `code: 'FST_ERR_VALIDATION'` — **não** é instância de
> `ValidationError`, e nem poderia ser, já que a taxonomia é abstrata e mora na
> camada pura. Pela regra acima, sem tratamento explícito **todo payload inválido
> responderia 500**.
>
> Portanto o handler testa `FST_ERR_VALIDATION` **antes** da cadeia de
> `instanceof`, converte para 400 + `VALIDATION_ERROR`, e traduz os códigos do Zod
> para os do contrato — que **não** são os mesmos: o Zod emite `invalid_format` e
> `too_small`, enquanto o contrato publica `INVALID_FORMAT` e `TOO_SHORT`. Sem
> tabela normativa dessa tradução, cada app derivado publica um contrato
> diferente. A `ValidationError` da taxonomia continua existindo para validação de
> **domínio**, lançada pelos value objects e use cases.

**Descartado — `AppError` com `statusCode`** (o padrão mais comum em boilerplate
Node): mais simples e reconhecível, mas faz HTTP vazar para a camada pura,
violando a decisão 02. Pior: worker e cron passariam a carregar `statusCode` sem
sentido, e o lint de fronteira não pega esse tipo de vazamento — é um campo, não
um import.

**Descartado — `Result`/`Either` tipado:** o compilador garantiria tratamento
exaustivo e o erro viraria parte do contrato do use case, o que é genuinamente
superior em rigor. Perdeu por verbosidade: todo call site desembrulha, o
boilerplate por endpoint cresce bastante, e há atrito com bibliotecas que lançam
de qualquer forma (driver, argon2) — o código acabaria misturando os dois estilos.

#### Formato do corpo de erro

```jsonc
// erro simples
{
  "error": {
    "code": "INVALID_CREDENTIALS",   // SCREAMING_SNAKE_CASE, estável
    "message": "Credenciais inválidas",
    "traceId": "01JXYZ..."
  }
}

// erro de validação -> details por campo
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Payload inválido",
    "details": [
      { "field": "email",    "code": "INVALID_FORMAT" },
      { "field": "password", "code": "TOO_SHORT" }
    ],
    "traceId": "01JXYZ..."
  }
}
```

**`code` é contrato; `message` não é.** O app mobile ramifica pelo `code` e usa
ele como chave de i18n para montar a mensagem localmente. A `message` do servidor
serve para log, debug e clientes sem tradução — **nunca deve ser exibida crua**
num app com i18n, ou vira texto em português numa tela em inglês.

**Motivo — é o formato dominante.** Stripe, Google e Microsoft usam envelope
aninhado com código estável:

| API | Formato |
|---|---|
| Stripe | `{ "error": { "type", "code", "message", "param" } }` |
| Google | `{ "error": { "code", "message", "status", "details" } }` |
| Microsoft / OData | `{ "error": { "code", "message", "details" } }` |

**Descartado — RFC 9457 (Problem Details):** é padrão IETF de verdade, com
content-type `application/problem+json` reconhecido por tooling, e a escolha certa
se algum app expuser API pública a terceiros. Perdeu por dois motivos: `status` e
`instance` duplicam o que o HTTP já informa, e `type` como URI que ninguém
hospeda vira cargo cult. Além disso, detalhe por campo e `traceId` teriam de ser
membros de extensão de qualquer forma — o RFC cobriria pouco mais da metade do
que precisamos. Vale registrar que boa parte da adoção dele vem de ASP.NET Core e
Spring Boot 3+, onde é default de framework, não escolha deliberada.

**Descartado — envelope plano:** mais curto, mas confunde raiz de erro com raiz
de sucesso e não tem lugar natural para o contrato crescer.

> ⚠️ **Este formato é contrato público.** Trocar depois é barato em código (um
> arquivo, o error handler) e **caro em coordenação**: com dois apps mobile em
> produção fazendo `switch` no `code`, mudar exige release coordenada nas lojas.
>
> **Ressalva para o futuro:** se entrar OAuth/OIDC (hoje em aberto), o endpoint de
> token tem formato de erro **mandatório** pela RFC 6749
> (`{ "error": "invalid_grant", "error_description": ... }`) e fica de fora desta
> convenção.

O `traceId` fecha o ciclo com o log — ver a decisão de logging.

---

### 14 — Env: módulo declara, boot valida tudo de uma vez

```ts
// modules/auth/config.ts — o módulo é dono das SUAS variáveis
export const authEnvSchema = z.object({
  JWT_SECRET:        z.string().min(32),
  ACCESS_TOKEN_TTL:  z.coerce.number().default(3600),      // 1h   (decisão 11)
  REFRESH_TOKEN_TTL: z.coerce.number().default(5_184_000), // 60d  (decisão 11)
  REFRESH_GRACE_SEC: z.coerce.number().default(30),        // janela de graça
})

// infra/config/env.ts — merge e validação UMA vez, no boot
const schema = coreEnvSchema.merge(authEnvSchema) /* .merge(futuros) */

export const env = schema.parse(process.env)
export type Env = z.infer<typeof schema>
```

**Motivo:** resolve a tensão entre module-first e fail-fast. O módulo continua
dono da sua configuração — coerente com as decisões 01 e 02, e deletar o módulo
leva as variáveis junto — mas a validação acontece num ponto só, então o processo
morre listando **todos** os problemas de uma vez, em vez de revelar um por
reinicialização.

**A config é injetada, não importada.** `makeContainer(db, env)` recebe o objeto
tipado, mantendo a coerência com a decisão 08: o grafo é explícito e um teste pode
montar o container com outra config sem mexer em `process.env`.

**Descartado — schema único global:** um arquivo responderia "o que eu preciso
configurar?" sem indireta, espelhando o `.env.example` 1:1. Perdeu porque a
configuração do módulo passaria a morar fora dele, o arquivo viraria a lista
concatenada de todos os módulos de todos os apps, e remover um módulo deixaria
variáveis órfãs.

**Descartado — cada módulo valida a sua:** autonomia total, mas fragmenta o
fail-fast — os erros aparecem em conta-gotas, um por reinicialização — e a ordem
de import passa a importar.

---

### 15 — Logging: camada pura muda, correlação por AsyncLocalStorage

> **Emendada em 2026-09-08.** A auditoria de 2026-09-07 mediu, não deduziu:
> lançou um `RefreshTokenReusedError` contra um servidor real e o `code` nunca
> apareceu no log. A tabela de cobertura abaixo tratava o `code` da RESPOSTA
> como se fosse a linha de log — ele é contrato do cliente; o error handler
> nunca escreveu nada no log para um `AppError` da taxonomia, só para o 500
> genérico. Um token roubado sendo reapresentado e um token expirado comum eram
> a mesma linha de log.
>
> Ganhou um segundo mecanismo, ortogonal ao `code`: `securityEvent: boolean`
> na base pura (`false` por padrão), que o error handler lê para emitir um
> `warn` com o `code` antes de responder — sem o use case logar, sem quebrar a
> regra desta decisão. `RefreshTokenReusedError` é o primeiro caso marcado: a
> família inteira é revogada quando ele é lançado, e essa revogação não podia
> continuar silenciosa.

> **Emendada em 2026-08-30.** O logger deixou de ser configuração do Fastify e
> virou infra própria: `createLogger` em `infra/observability/logger.ts`, que o
> `server.ts` recebe por `loggerInstance`. O esboço desta decisão já previa esse
> arquivo; ele só não existia porque, até a transação ganhar retry, apenas o
> Fastify precisava logar.
>
> O que forçou a extração foi a decisão 10: o composition root é compartilhado
> por `http`, `worker` e `cron`, e um worker sem logger próprio montaria o dele —
> duplicando o `REDACT_PATHS`. Essa lista é o que mantém hash de senha e token
> fora do log, e duas cópias dela é como o primeiro worker vaza um.


> **Emendada em 2026-08-29.** O ALS deixou de ser uso único: a guarda de
> aninhamento do Unit of Work é o segundo. A distinção que sustenta a exceção é a
> mesma que a decisão 22 usou para **rejeitar** ALS ali — ela recusou transação
> ambiente porque a transação sumiria da assinatura e o repositório resolveria a
> conexão a partir de estado invisível. Aqui o storage carrega um booleano, nenhum
> repositório o lê, a transação continua explícita no parâmetro `repos`, e o único
> efeito possível do flag é lançar. É **detecção**, não propagação.

**O use case não loga e não recebe logger.** Quem loga é a fronteira e a infra,
todos correlacionados por um contexto de request ambiente.

```ts
// infra/observability/context.ts — ~15 linhas, isola o mecanismo
const als = new AsyncLocalStorage<{ traceId: string }>()

export const runWithContext = (id: string, fn: () => void) =>
  als.run({ traceId: id }, fn)

export const traceId = () => als.getStore()?.traceId

// hook do Fastify
app.addHook('onRequest', (req, _, done) => runWithContext(req.id, done))
```

**Cobertura que sobra sem o use case logar:**

| Origem | O que registra |
|---|---|
| Fastify | request, status, duração, `reqId` |
| Error handler — erro fora da taxonomia | `error` com o erro completo + `traceId` (13) |
| Error handler — erro da taxonomia com `securityEvent: true` | `warn` com o `code` + `traceId` |
| Infra | query lenta, falha de driver |
| Taxonomia de erro (13) | **o `code` já diz qual ramo caiu, na RESPOSTA** |

Esse último item é o que torna a opção viável PARA O CLIENTE: como a decisão 13
dá a cada falha um código semântico, `INVALID_CREDENTIALS` versus
`USER_NOT_FOUND` já chega diferenciado no corpo, e replicar isso num log dentro
do use case seria redundante com o erro que ele lança.

**Não é o mesmo para o SERVIDOR.** O código na resposta não é uma linha de log —
é só o que o handler ecoa de volta. A maioria das falhas da taxonomia não
precisa de uma: são tráfego de cliente (senha errada, token expirado), não
evento a investigar, e logar cada uma seria ruído. A exceção é a falha que É o
sinal — reuso de refresh token detectado, família inteira revogada — e é isso
que `securityEvent` cobre, marcando na própria classe do erro quem precisa
do `warn`.

**Redação de segredo é obrigatória** — `password`, `Authorization`, `token` e o
cookie de refresh (decisão 12) nunca podem cair em log. O pino tem `redact`
nativo:

```ts
redact: {
  paths: ['req.headers.authorization', 'req.headers.cookie',
          '*.password', '*.token', '*.refreshToken'],
  censor: '[REDACTED]',
}
```

**Resolve o pendente da decisão 08** — escopo por request (correlation id,
contexto de transação) fica no ALS, não em escopo de container nem em parâmetro
propagado à mão.

#### Sobre OpenTelemetry

**OTel e ALS não são alternativas: o context propagation do OTel em Node *é*
AsyncLocalStorage** (`@opentelemetry/context-async-hooks`). OTel é ALS mais
`trace_id` padrão W3C propagado entre serviços, auto-instrumentação de
Fastify/HTTP/Postgres, e correlação log↔trace via
`@opentelemetry/instrumentation-pino`.

**Adiado, não rejeitado.** O custo que pesa não é CPU — é operacional: OTel só
entrega valor com um destino (collector, Jaeger, Tempo, Datadog), o que significa
mais um serviço no compose e uma decisão de infra **em todo app derivado**. Num
boilerplate, esse escopo se multiplica.

O código consumidor não conhece o mecanismo, então a migração é **um arquivo**:

```ts
// infra/observability/context.ts, versão OTel
export const traceId = () => trace.getActiveSpan()?.spanContext().traceId
```

**Gatilho para adotar:** o primeiro app que precisar de tracing distribuído de
verdade — ou seja, quando esses serviços começarem a conversar entre si.

**Sobre performance:** ALS puro é desprezível numa API com I/O de banco — mesmo
argumento do `new` na decisão 08. OTel completo tem custo mensurável (span,
atributo, exportação), mitigado por sampling. Se virar preocupação, é caso de
medir no cenário real, não de acreditar em benchmark de blog.

**Descartado — `ILogger` injetado no use case:** o contrato na camada pura
preservaria a fronteira e daria observabilidade dentro da regra. Perdeu porque
faria todo construtor crescer e todo teste ganhar um no-op logger, **sem dispensar
o mecanismo de correlação** — seria a opção escolhida mais um parâmetro, não um
substituto. E convida a log redundante com o erro tipado.

**Descartado — contexto explícito no `execute()`:** zero magia e o `traceId`
seguível a olho, mas é viral — o `ctx` contamina toda assinatura, inclusive a dos
repositórios, e esquecer de repassar quebra a correlação em silêncio.

**Custo aceito:** nenhuma visibilidade dentro da regra de negócio, e o ALS é o
único ponto de contexto implícito do projeto.

---

### 16 — Docker: compose só para infra, aplicação no host

```
docker-compose.yml        aplicação
  postgres:5432             pnpm dev  (tsx watch, no HOST)
  (redis, mailhog...)
```

```bash
docker compose up -d   # infra
pnpm dev               # app, no host
```

**Motivo:** é a decisão que o time sente **toda manhã**, não só em produção.
Aplicação no host dá o loop de iteração mais rápido (arquivo local, sem bind
mount), debugger e profiler anexam sem configuração, e o compose sobe em segundos
porque carrega só infra.

**Mitigação do "na minha máquina funciona"** — o custo real dessa escolha:
`.nvmrc` + `engines` travam a versão do Node, e **o CI roda em container**, então
qualquer deriva entre o host do dev e o ambiente real aparece no pipeline, não em
produção.

**Descartado — tudo no compose:** paridade real com produção e dev sem precisar de
Node instalado. Perdeu porque watch por bind mount é lento fora do Linux, debugger
e profiler exigem configuração extra, e cada mudança de dependência pede rebuild
de imagem — atrito diário multiplicado por todo time que herdar a base.

**Descartado — Dev Container:** toolchain inteira versionada no repo e onboarding
de um clique, que é genuinamente atraente num boilerplate. Perdeu por amarrar a
experiência ao VS Code, pesar no primeiro start e adicionar mais uma camada para
depurar quando algo quebra.

#### Imagem de produção (não debatido — consenso)

Multi-stage, `node:<lts>-alpine` ou distroless, usuário não-root, e
`pnpm deploy --prod` para gerar um `node_modules` podado sem as dependências de
build. O estágio de build gera `dist/`; o de runtime recebe só `dist/` e as
dependências de produção.

Ver decisão 17 para o banco dos testes de integração.

---

### 17 — CI no GitHub Actions; testes de integração em banco `app_test` (revisada em 2026-08-21)

> **O banco de teste desta decisão foi revisado na configuração do Vitest.** A
> escolha original era um banco `app_test` dentro da mesma instância do compose.
> Passou a ser um **serviço dedicado**: `postgres-test`, porta 5433, banco
> `api_clean_platform_test`, com `tmpfs` no lugar de volume.
>
> **O que derrubou a escolha original.** Criar um segundo banco na mesma
> instância exige ou um script em `/docker-entrypoint-initdb.d`, que **só roda em
> volume novo** e portanto não alcança quem já tem o volume criado, ou um
> `createdb` manual fora do compose. Nenhum dos dois é reprodutível num
> boilerplate copiado N vezes. Com serviço próprio, `docker compose up -d` basta,
> em qualquer máquina, sempre.
>
> **Ganho não previsto:** o `tmpfs` mantém o cluster em RAM e faz do restart do
> container o reset do estado. Isso rebaixa o `TRUNCATE ... CASCADE` entre testes
> de questão de correção para questão de velocidade. E a suíte fica
> fisicamente incapaz de alcançar dado de desenvolvimento.
>
> **Custo aceito:** um container a mais de pé durante o desenvolvimento.
>
> O resto da decisão segue valendo intacto: CI no GitHub Actions, Postgres como
> service container (o compose não é usado lá), migration como passo separado do
> deploy e a ordem do pipeline.

```
compose (dev)              CI (service container)
  postgres                   postgres:17
    app       <- dev           app_test
    app_test  <- testes
```

**Banco de teste:** o mesmo Postgres que já sobe no compose (decisão 16) hospeda
um banco `app_test` separado. Migrations rodam uma vez antes da suíte;
`TRUNCATE ... CASCADE` isola os testes entre si.

**Motivo:** zero dependência nova, arranque instantâneo — o banco já está de pé —
e o banco separado protege os dados de desenvolvimento de serem apagados pela
suíte. CI e local usam o mesmo desenho, só mudando quem provisiona o Postgres.

**Pipeline:**

```yaml
# .github/workflows/ci.yml
services:
  postgres: { image: postgres:17 }

steps:
  - pnpm install --frozen-lockfile   # lockfile divergente falha aqui
  - pnpm lint                        # inclui o lint de fronteira (02, R5, R6)
  - pnpm typecheck
  - pnpm test:unit                   # sem I/O, milissegundos
  - drizzle-kit migrate              # contra o banco de teste
  - pnpm test:integration
  - pnpm build                       # pega erro que só aparece no build
```

**O CI roda em container**, o que é a mitigação registrada na decisão 16 para o
risco de "na minha máquina funciona": qualquer deriva entre o host do dev e o
ambiente real aparece no pipeline.

**Migration em deploy roda como passo separado, nunca no boot da aplicação.**
Com múltiplas instâncias subindo em paralelo, migrar no boot cria corrida. Sendo
forward-only (R4), a ordem correta é: aplicar migration, depois subir a nova
versão — o que exige que cada migration seja compatível com a versão anterior do
código (expand/contract).

**Descartado — testcontainers:** isolamento real, idêntico em qualquer máquina e
paralelismo trivial com um container por worker. Perdeu pelo arranque de dezenas
de segundos a cada execução, por exigir Docker sempre disponível e por adicionar
dependência pesada ao core do boilerplate. É a alternativa natural se isolamento
por teste virar necessidade.

**Descartado — schema por worker:** paralelismo seguro sem container extra, mas
exige setup caseiro de criação e limpeza de schema, roda as migrations uma vez por
worker, e `search_path` errado gera bug confuso de depurar.

**Custo aceito:** estado compartilhado entre workers paralelos. Se a suíte de
integração crescer a ponto de precisar de paralelismo, a saída é schema por worker
ou testcontainers — as duas alternativas ficam registradas acima.

---

### 18 — Lint de fronteira: `dependency-cruiser` (revisada em 2026-08-20)

> **Esta decisão foi revertida.** A escolha original era `eslint-plugin-boundaries`,
> pelo feedback inline no editor. A auditoria de 2026-08-20 mostrou empiricamente
> que ela **não funciona junto com a decisão 19**.

**O que derrubou a escolha original.** Testado com `eslint-plugin-boundaries@7.2`,
`eslint-plugin-import@2.32` e `eslint-import-resolver-typescript@4.4.5`, sobre
duas violações idênticas:

```
../infra/in-memory/in-memory-users-repository.js   -> acusa           ✅
#modules/auth/infra/in-memory/in-memory-users-repository -> passa     ❌
```

O resolver não resolve o especificador `#` (campo `imports` do package.json) e o
`boundaries` **ignora silenciosamente todo import não resolvido**. Como a decisão
19 estabelece que *não há path alias* e tudo usa `#`, **100% dos imports entre
diretórios ficariam invisíveis ao lint**.

Esse é o pior resultado possível, não apenas um resultado ruim: a decisão 02
achatou a árvore **porque** o lint garantiria a fronteira. Sem o lint enxergando
nada, sobra árvore achatada *e* zero enforcement, com o CI verde e ninguém
desconfiando — replicado em todo app derivado.

**A escolha agora:**

| Ferramenta | Responsabilidade |
|---|---|
| `dependency-cruiser` | A tabela de fronteira da decisão 02 e R5, mais detecção de ciclo e geração do grafo |
| ESLint puro | R6 (`process.env`) e R7 (tempo e aleatoriedade) — são regras de **sintaxe**, não de dependência |

`dependency-cruiser` usa `enhanced-resolve` e portanto entende o campo `imports`.
Estava registrado como complemento opcional na versão original desta decisão;
passou a ser o enforçador principal.

**Dados de manutenção (2026-08-20)** — o que descartou as demais alternativas:

| Ferramenta | Versão | Última publicação |
|---|---|---|
| `dependency-cruiser` | 18.2.0 | 2026-08-10 |
| `eslint-plugin-boundaries` | 7.2.0 | 2026-08-09 (ativa, mas não resolve `#`) |
| `tsarch` | 5.4.1 | 2024-12-23 — **parada há 20 meses** |
| `@softarc/sheriff` | — | **não existe no registro** |

**Descartado — abandonar `#` e voltar a import relativo:** preservaria o
`boundaries` e o feedback inline. Perdeu porque devolveria os caminhos `../../..`
ao projeto inteiro, revogando o ganho central da decisão 19, e porque mover pasta
passaria a quebrar caminho em massa.

**Descartado — script próprio com `ts-morph`:** resolveria exatamente como o
`tsc`, com mensagem de erro sob medida. Perdeu por virar código que o boilerplate
passa a manter — com bug próprio — e por não trazer ciclo nem grafo sem
implementá-los.

**Custo aceito:** perde-se o feedback inline no editor, que foi o argumento que
ganhou a decisão original. A fronteira passa a falhar no `pnpm lint` e no CI.

> **Critério de aceite obrigatório.** Um fixture por linha da tabela de fronteira,
> escrito **com especificador `#`**, que precisa **falhar** a verificação. Sem
> isso, a configuração pode parecer correta e não enforçar nada — que é
> exatamente a armadilha que derrubou a escolha original.

---

### 19 — Path alias: subpath imports do Node; build é `tsc` puro

```jsonc
// package.json
"imports": {
  "#modules/*": {
    "development": "./src/modules/*.ts",
    "default":     "./dist/modules/*.js"
  },
  "#shared/*":  { "development": "./src/shared/*.ts",  "default": "./dist/shared/*.js"  },
  "#infra/*":   { "development": "./src/infra/*.ts",   "default": "./dist/infra/*.js"   }
}
```

```ts
import { AuthenticateUserUseCase } from '#modules/auth/use-cases/authenticate-user'
```

```bash
pnpm dev     # tsx --conditions=development src/main/http.ts
pnpm build   # tsc
pnpm start   # node dist/main/http.js
```

**Motivo: elimina a classe inteira do problema em vez de remediar.** O `tsc` não
reescreve path alias na saída — é por isso que `tsc-alias` existe, e é um patch.
Subpath import é resolvido **pelo Node**, então funciona igual no `tsx` em
desenvolvimento, na saída do `tsc` em produção e em qualquer runner de teste.
Nenhuma etapa de reescrita, nenhum bundler obrigatório.

Requer `moduleResolution: "nodenext"` no TypeScript para que ele entenda o campo
`imports`.

**Custo aceito:** o prefixo `#` é menos familiar que `@/`, e o mapa mora no
`package.json` em vez do `tsconfig.json`.

**Descartado — bundler (tsup/tsdown/esbuild):** resolveria alias e geraria imagem
menor, mas bundlar servidor traz risco com require dinâmico e dependência nativa.
Continua disponível depois, se tamanho de imagem virar prioridade.

**Descartado — `tsc` + `tsc-alias`:** funciona, mas é remendo para um problema que
os subpath imports simplesmente não têm.

---

### 20 — Mappers: funções puras na camada de infra

```ts
// modules/auth/infra/drizzle/user-mapper.ts
export const toDomainUser      = (row: UserRow): User      => ...
export const toPersistenceUser = (user: User):  NewUserRow => ...
```

**Motivo:** função em vez de classe com métodos estáticos, porque não há estado a
carregar. E mora em `infra/` porque **conhece o formato da row** — colocar a
conversão na entidade faria a camada pura saber de persistência, furando a
decisão 02.

Fecha o custo que a decisão 06 tinha aceito sem definir formato.

> **Confirmada em 2026-08-26.** A entidade `User` usa campos `#` privados por um
> motivo que não é estilo: `JSON.stringify(user)` devolver `{}` é garantia de
> runtime. O achado que tornou isso concreto: `REDACT_PATHS` redigia `password` e
> `*.password`, mas não cobria `passwordHash` — o redact do pino casa nome de
> chave exato. Uma entidade com campo público `passwordHash` vazaria o hash em
> log. Esta fatia corrigiu o `REDACT_PATHS` **e** fechou o furo estruturalmente
> com os campos `#`.
>
> **Descartado — snapshot na entidade (`toSnapshot()` / `fromSnapshot()`, como no
> byteflow):** mais curto, um arquivo a menos. Perdeu porque a brevidade dela vem
> de deixar a row do Drizzle entrar na camada pura — um `UserSnapshot` puro é
> estruturalmente compatível com `typeof users.$inferSelect`, e é exatamente o
> custo que esta decisão já nomeia acima: conhecer o formato da row é assunto de
> `infra/`, não da entidade.

---

### 21 — Providers: contrato em `ports/`, implementação em `infra/providers/`

> **Emendada em 2026-08-29.** "Contrato em `shared/ports/`, implementação em
> `infra/providers/`" foi escrito quando o único port transversal era o `IClock`.
> Adapter de **banco** vai para `infra/database/`: é onde o `Database` de que ele
> depende é declarado, e o projeto já tinha o precedente — `DrizzleUsersRepository`
> mora em `modules/auth/infra/drizzle/`, pasta nomeada pela tecnologia, não em
> `infra/providers/`. A regra geral continua valendo; o que ela nomeia é a
> **camada**, não uma pasta única.

> **Emendada em 2026-08-29.** As pastas de contrato passaram de `providers/` para
> **`ports/`** — `modules/auth/ports/` e `shared/ports/`. O motivo é de leitura da
> árvore: contrato e implementação chamavam-se `providers/` os dois, então
> `modules/auth/providers/` e `modules/auth/infra/providers/` (e o par
> `shared/` / `infra/`) eram indistinguíveis sem expandir as duas.
>
> `repositories/` não tinha o problema, e a razão é a pista que decidiu: a
> implementação dele mora em `infra/drizzle/`, nomeada pela **tecnologia**.
> `infra/providers/` era a única pasta de `infra/` nomeada pelo **papel**.
> Renomear o contrato para `ports/` — o termo exato para contrato definido pela
> camada de dentro — desfaz a duplicação sem inventar convenção nova.
>
> As pastas de implementação **não** mudaram: `infra/providers/` e
> `modules/auth/infra/providers/` seguem com o nome e o conteúdo de antes.

> **Emendada em 2026-08-26.** O `ITokenGenerator` do sketch abaixo foi partido em
> dois: `IIdGenerator { generate() }` nasce agora, em `shared/ports/`, e
> `ITokenGenerator { opaque() }` fica para a fatia de refresh token. Id de
> entidade e segredo criptográfico têm perfis de segurança e motivos de mudar
> diferentes — trocar UUIDv4 por v7 não tem nada a ver com a entropia de um
> refresh token, e o `uuid()` do sketch original fica supérfluo com o
> `IIdGenerator` dedicado.
>
> O `IHashProvider` também nasce menor do que o sketch: só `hash()`. `compare()`
> chega com o login, quando existir algo para comparar contra.

> **Emendada em 2026-09-01.** `ITokenGenerator` nasceu, **sem** o `uuid()` do
> sketch original, e ao lado dele nasceu **`ITokenDigest`** — pelo mesmo critério
> de "motivos de mudar diferentes" que já havia partido o port uma vez. Gerar um
> segredo e torná-lo indexável mudam por razões distintas.
>
> A separação não é estética: com a digest atrás de porta própria, **não existe
> na camada pura um objeto de onde argon2 e o digest do refresh sejam
> alcançáveis ao mesmo tempo**. O aviso desta mesma seção sobre argon2 deixa de
> ser comentário e vira estrutura.

Nem toda dependência externa é repositório. Hash de senha, assinatura de JWT e
**relógio** são dependências de infraestrutura que o use case consome por
contrato, e até aqui não tinham endereço definido.

```ts
// modules/auth/ports/hash-provider.ts        (PURO — contrato)
export interface IHashProvider {
  hash(plain: string): Promise<string>
  compare(plain: string, hashed: string): Promise<boolean>
}

// modules/auth/ports/token-signer.ts         (PURO — contrato)
export interface ITokenSigner {
  sign(payload: AccessTokenPayload): Promise<string>
  verify(token: string): Promise<AccessTokenPayload>
}

// shared/ports/clock.ts                      (PURO — contrato transversal)
export interface IClock { now(): Date }
```

```
modules/auth/ports/            contratos do módulo
modules/auth/infra/providers/      argon2-hash-provider.ts, jwt-token-signer.ts
shared/ports/                  contratos transversais (IClock)
infra/providers/                   system-clock.ts
```

**Por que o relógio é provider, e não `new Date()` espalhado.** Todo o desenho da
decisão 11 é temporal: TTL de 1h, 60 dias deslizantes, janela de graça de 30
segundos, `expires_at`. Sem `IClock` injetável, **o teste unitário obrigatório da
rotação de refresh (decisões 09 e 11) não tem como existir** — não dá para testar
expiração e janela de graça sem controlar o tempo. Relógio é mundo externo pela
mesma definição que banco e rede são.

```ts
// shared/ports/token-generator.ts          (PURO — contrato transversal)
export interface ITokenGenerator {
  /** valor opaco criptograficamente seguro, para refresh token e afins */
  opaque(bytes?: number): string
  uuid(): string
}
```

> **`ITokenSigner` não produz o refresh token.** Ele assina e verifica o *access*
> JWT. O refresh é valor **opaco e persistido** (decisão 11) e nasce do
> `ITokenGenerator`. Confundir os dois leva a implementar refresh como JWT, que é
> exatamente a opção C descartada.

**Regra:** use case nunca chama `new Date()`, `Date.now()`, `Math.random()` nem
`crypto.randomUUID()` direto. Tempo e aleatoriedade entram por contrato — é o que
torna determinístico o teste de expiração, janela de graça e detecção de reuso.

---

### 22 — Atomicidade: Unit of Work explícito

> **Emendada em 2026-08-29**, pela fatia que a implementou. O contrato nasceu
> **genérico e transversal** — `IUnitOfWork<TRepos>` em `shared/ports/` — e não
> `IAuthUnitOfWork` dentro do módulo: o padrão se repete em todo módulo, e o
> esboço abaixo o faria renascer inteiro no segundo.
>
> Ele vem em **duas camadas**. Um `TransactionRunner` sem contexto abre a
> transação, faz commit/rollback e recusa aninhamento; `createUnitOfWork(runner,
> buildRepos)` casa esse runner com a fábrica de repositórios de um módulo. A
> mecânica da transação passa a existir **uma vez** no projeto, e um use case que
> legitimamente atravesse dois módulos funde as duas fábricas sobre a **mesma**
> transação — empilhar dois Units of Work seriam duas transações, que é o defeito
> que a guarda existe para pegar.
>
> A forma é **chamável** (`uow(work)`), não objeto com `.run()`: o objeto não tem
> estado nem segunda responsabilidade, então era embalagem sem conteúdo.
>
> E ganhou **guarda de aninhamento**. O `db.transaction` do Drizzle sobre o
> handle do pool tira **outra conexão**, então um `uow` dentro de outro abre
> transação independente, não savepoint: a de dentro commita enquanto a de fora
> faz rollback, e as duas travam de vez quando a de fora segura um lock de linha
> que a de dentro pede — impasse que o Postgres não quebra, porque a transação
> externa não espera lock, espera JavaScript. Desenho completo em
> [`specs/2026-08-29-unit-of-work-design.md`](superpowers/specs/2026-08-29-unit-of-work-design.md) §4.

> **Emendada em 2026-09-01.** Há uma **segunda razão legítima** para receber o
> UoW, e ela não é atomicidade: o **retry de deadlock**. `logout` e `logout-all`
> escrevem num repositório só e ainda assim o recebem, porque a rotação trava
> uma linha e depois atualiza a família inteira enquanto eles atualizam a
> família direto — conjuntos de linhas sobrepostos travados em ordens
> diferentes, um AB-BA clássico, com `40P01` alcançável. Fora do runner isso
> vira 500 num pedido em que nada estava errado.
>
> E uma restrição de uso que a fatia 7 pagou para descobrir: **nada que precise
> sobreviver ao `throw` pode ser escrito e depois lançado de dentro do
> callback** — o rollback desfaz a escrita. Quando a operação precisa persistir
> *e* falhar, o resultado sai da transação como dado e o erro é lançado depois
> do commit.

Um use case que escreve em mais de um repositório precisa de transação. Com
repositório devolvendo entidade de domínio, coordenar isso é o problema clássico
da Clean Architecture — e a rotação de refresh token cai exatamente nele: revogar
o antigo, inserir o novo e marcar `replaced_by` têm de ser atômicos.

```ts
// modules/auth/repositories/unit-of-work.ts      (PURO — contrato)
export interface AuthRepos {
  users:         IUsersRepository
  refreshTokens: IRefreshTokensRepository
}

export interface IAuthUnitOfWork {
  run<T>(fn: (repos: AuthRepos) => Promise<T>): Promise<T>
}
```

```ts
// use case: a transação está VISÍVEL na assinatura
constructor(private uow: IAuthUnitOfWork) {}

async execute(dto: RefreshTokenDTO) {
  return this.uow.run(async ({ refreshTokens }) => {
    await refreshTokens.revoke(current)   // versões ligadas à transação
    await refreshTokens.save(next)
  })
}
```

A implementação vive em `infra/drizzle/`, abre `db.transaction` e entrega os
repositórios ligados àquela transação.

**Motivo:** zero contexto implícito. A transação aparece na assinatura, o escopo
de quais repositórios participam é explícito, e testar exige só um fake que
executa a função recebida.

> **O UoW é para quem precisa dele.** Use case que escreve num repositório só
> continua recebendo o repositório direto. Injetar UoW em tudo faria o caso
> simples pagar o custo do complexo.

**Descartado — transação ambiente no ALS:** reaproveitaria o contexto que já
existe (decisão 15), nenhuma assinatura mudaria e seria impossível esquecer de
propagar. Perdeu por ser o **segundo** ponto de contexto implícito do projeto —
a decisão 15 aceitou o ALS como exceção única e consciente, e transação invisível
na assinatura é bem mais perigosa que `traceId` invisível.

**Descartado — operação atômica no repositório** (`rotate(old, next)` como um
método só): mantém a camada pura sem ouvir falar de transação e é o mais simples.
Perdeu por só resolver **dentro** de um agregado — dois repositórios na mesma
transação ficam descobertos — e por inchar o contrato com métodos compostos.

---

### 23 — O plugin do módulo recebe **a fatia dele** do container

> **Emendada em 2026-08-26.** O exemplo abaixo monta o container em
> `main/http.ts`; na prática ele é montado dentro de `main/app.ts` (`buildApp`),
> porque o exemplo original é anterior ao commit `748c41a`, que passou a compor a
> aplicação ali para que a suíte de integração exercite o grafo real sem subir
> servidor. A substância da decisão fica intacta: o grafo continua independente
> de framework, e cada plugin de módulo continua recebendo só a fatia dele.

```ts
// main/http.ts
const container = makeContainer(db, env)          // grafo montado SEM Fastify

await app.register(authRoutes, {
  prefix: '/auth',
  container: container.auth,                      // só a fatia do módulo
})

// modules/auth/infra/http/endpoints/authenticate.ts
export const authenticateRoute:
  FastifyPluginAsync<{ container: AuthContainer }> = async (app, { container }) => {
    container.authenticateUser   // ok
    container.products           // ERRO DE COMPILAÇÃO — nem existe no tipo
  }

// main/worker.ts
const container = makeContainer(db, env)          // mesmo grafo, sem Fastify
```

**Motivo:** o compilador barra sozinho o acesso entre módulos, sem depender de
lint. E é coerente com a decisão 14, que já entrega ao módulo **a fatia da
config** em vez do `Env` global — o container é um objeto *maior* que a config,
porque carrega os use cases; restringir a config e entregar o grafo inteiro seria
incoerente.

**Descartado — `app.decorate('container', container)` global:** mais direto de
escrever, e a decisão 08 não o proíbe (ela rejeitou o `decorate` como *mecanismo
de injeção*, não como *transporte*). Perdeu por um motivo que a auditoria de
2026-08-20 tornou concreto: `decorate` exige `declare module 'fastify'`, que é
**global e ambiente**. Uma vez escrita, todo endpoint de todo módulo enxerga
`app.container.<qualquer módulo>` com tipagem completa — e isso é **acesso a
propriedade, não import**, então nenhum lint de fronteira pega. R5 seria violável
sem deixar rastro.

**Nota que vale para os dois caminhos:** o grafo continua independente de
framework, que é o que a decisão 10 exige para worker e cron.

---

### 24 — Schema mora no módulo; FK só dentro do módulo

Os arquivos de schema ficam em `src/modules/<m>/infra/drizzle/schema/`, um por
tabela e nomeado pela tabela (`users.ts`, `refresh-tokens.ts`), onde o
glob da decisão 06 já procura. Consequência direta da linha `module-infra` da
regra de fronteira (decisão 18): um módulo não importa o `infra/` de outro,
então **um schema não pode referenciar a tabela de outro módulo**.

| Foreign key | Situação |
|---|---|
| `refresh_tokens.user_id → users.id` (ambos em `auth`) | Legal — mesmo módulo |
| `orders.user_id → users.id` (`orders` → `auth`) | Proibida |

Entre módulos, referencia-se **por id, sem constraint**: coluna `uuid('user_id')`
sem `.references()`, integridade na aplicação.

**Por que não é limitação:** é a mesma restrição que existiria se os módulos já
fossem serviços separados, e é o que faz "módulo extraível" ser real. Com FK
física de `orders` para `users`, extrair `orders` vira migração de dados em vez
de mover arquivos.

**Custo aceito:** sem integridade referencial no banco entre módulos. `ON DELETE`
passa a ser regra de aplicação ou evento de domínio, não constraint.

Desenho completo em
[`specs/2026-08-25-users-schema-first-migration-design.md`](superpowers/specs/2026-08-25-users-schema-first-migration-design.md) §5.

---

### 25 — `register` responde `202`, sempre — quebra deliberada do contrato publicado

Até a fatia 10, `POST /auth/register` respondia `201 { id }` para um endereço
livre e `409 EMAIL_ALREADY_IN_USE` para um já tomado. O `409` é um oráculo de
contas: qualquer anônimo descobre se um endereço tem conta aqui, sem precisar
de senha nenhuma.

A partir da fatia 10, o endpoint responde `202`, sem corpo, em **todo** caso —
endereço livre, endereço já tomado e verificado, endereço já tomado e ainda
não verificado. A diferença que sobrevive não está mais na resposta HTTP: está
em qual e-mail o endereço recebe, e só o dono do endereço pode ler um e-mail.

**Dito sem rodeio: isto é quebra deliberada de um contrato publicado.** `id`
some do corpo, `201` e `409` somem dos códigos possíveis. Um cliente que
fizesse `switch` no status ou lesse `response.id` quebra.

**Por que teve de ser NESTA fatia, e não numa fatia de "limpeza de contrato"
adiada.** Fechar o oráculo exige um canal que divirja sem que a resposta HTTP
divirja — e antes desta fatia não existia e-mail nenhum saindo do sistema. Não
havia como responder igual e ainda assim entregar a cada um a informação certa.
É aqui ou nunca; adiar a quebra é adiar o fechamento do oráculo, não evitá-lo.

**Custo aceito:** o `id` sai da resposta sem substituto. Ele nunca serviu para
muita coisa — `register` não emite sessão —, mas era contrato publicado, e
algum cliente pode estar lendo. **Descartado:** `202 { id }`, devolvendo o id
da conta existente na colisão — preserva o campo, mas vaza mais que o `409`
que se pretende fechar, entregando o identificador interno de uma conta alheia
a qualquer anônimo.

Desenho completo em
[`specs/2026-09-03-email-verification-design.md`](superpowers/specs/2026-09-03-email-verification-design.md) §6.1.

### 26 — Sem backfill de `email_verified_at`, e ressalva normativa para apps derivados

A fatia 10 liga um gate em `login`: senha certa não basta, a conta também
precisa estar com `email_verified_at` preenchido. Ligar esse gate tranca **toda**
conta existente, porque `User.create` sempre gravou `emailVerifiedAt: null` e
nada, antes desta fatia, jamais escreveu outro valor — 100% das linhas de
`users` têm a coluna nula.

**A saída escolhida é nenhuma migração de dados.** Não é omissão; é decisão
registrada. Este projeto é boilerplate: não existe conta real em lugar nenhum,
então não há ninguém para grandfather. Escrever uma migração de backfill aqui
seria resolver um problema que este repositório não tem.

> ⚠️ **Ressalva normativa para apps derivados.** Um app que nasceu deste
> boilerplate e **já está em produção**, com contas reais, precisa escrever a
> própria migração de grandfathering —
> `UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL`
> — **antes** de puxar esta fatia para dentro do seu repositório. Sem ela, o
> merge é uma queda de login em massa: todo usuário existente passa a levar
> `EmailNotVerifiedError` no próximo login. E é o tipo de falha que **passa em
> toda a suíte de testes**, porque os testes criam contas novas dentro do mesmo
> cenário que as verifica — nenhum teste representa uma conta antiga.

Desenho completo em
[`specs/2026-09-03-email-verification-design.md`](superpowers/specs/2026-09-03-email-verification-design.md) §6.4.

---

### 27 — A conta nasce na confirmação, com a senha do request de confirm — fecha o account pre-hijacking

A fatia 10 introduziu, e estreitou sem fechar, uma vulnerabilidade real de
**account pre-hijacking**: como só um código fica vivo por endereço e a senha da
conta é a do último cadastro antes da confirmação, um atacante que recadastre o
endereço da vítima entre o cadastro dela e a confirmação faz a conta nascer com a
senha dele.

A fatia 11 move a criação da conta para a confirmação. `POST /auth/register`
passa a receber **só** `{ email }` e grava uma linha em `pending_registrations` —
um código de uso único ligado a um endereço, **sem senha**. `POST
/auth/email/verify` passa a receber `password`, casa o código contra **todos** os
pendentes utilizáveis do endereço e, no match, cria a linha de `users` já
verificada **com a senha daquele request**, numa transação que também consome o
pendente e emite a sessão. Vários pendentes por endereço coexistem — são
fungíveis, e é por isso que fecha: quem completa a confirmação escolhe a senha, e
completar exige um código que só chegou na caixa do dono do endereço. O que sobra
é o resíduo irredutível de qualquer verificação por e-mail (o atacante ter acesso
à caixa da vítima, ou adivinhar o código de 6 dígitos dentro do teto de 5 e do
TTL de 15 min).

**Quebra de contrato deliberada, em cima da decisão 25:** `POST /auth/register`
perde o campo `password` (schema `.strict()`, então um cliente antigo que ainda
mande `password` toma `400`); `POST /auth/email/verify` ganha `password`
obrigatório. `register` e `resend` param de abrir transação e perdem o `503`.
Barato agora — boilerplate, sem cliente, sem front —, e é o mesmo raciocínio da
decisão 25: adiar a quebra é adiar o fechamento.

**Custo aceito:** o `confirm` paga argon2 em toda tentativa, inclusive código
errado, para o tempo de `match` e `no-match` ser igual (mesmo padrão do hash-isca
do `login`); um pendente que perdeu a corrida do `users.save` fica permanentemente
não-resgatável; a poda dos pendentes é oportunista até a fatia do `cron.ts`; e o
gate de `login` / a nulabilidade de `email_verified_at` ficam sem produtor até o
login social.

**Descartado:**

- **4.1 — o pendente carrega o hash da senha, a conta nasce com a senha do
  pendente.** Remove o hijack *determinístico* da fatia 10, mas deixa um resíduo
  de timing + confusão de inbox: se o atacante mantém um código vivo na caixa da
  vítima e ela digita **esse** em vez do dela, a conta nasce com a senha
  pré-registrada do atacante. Foi desenhada por inteiro antes de ser recusada.
- **Link de confirmação por pendente** em vez de código de 6 dígitos — fecharia o
  resíduo da 4.1 mantendo a senha no `register`, mas vai contra a decisão §6.2 da
  fatia 10 ("código, não link", digitável no celular).
- **Expirar conta não verificada** — não fecha, só limita a janela de squatting.

Desenho completo em
[`specs/2026-09-06-account-pre-hijacking-design.md`](superpowers/specs/2026-09-06-account-pre-hijacking-design.md).

---

### 28 — Exceção pontual a R4: a migration de `email_verification_tokens` foi apagada

R4 diz que migration aplicada é imutável. A migration
`20260904014721_create_email_verification_tokens_table` foi **apagada**, não
seguida por uma de `DROP`. É seguro porque não há ambiente deployado: a migration
só viveu em CI (efêmero, recriado a cada run) e no Postgres local do
desenvolvedor (sob controle dele — `docker compose down -v` resolve). A tabela
existiu apenas entre as fatias 10 e 11.

`pnpm db:generate` foi rodado de novo com a tabela fora do schema, diferenciando
contra o snapshot de `create_refresh_tokens_table` — o histórico ficou `users →
refresh_tokens → pending_registrations`, como se `email_verification_tokens`
nunca tivesse existido.

**Custo aceito:** R4 é regra escrita; esta é a exceção registrada, e não se
repete. A alternativa R4-limpa (uma migration nova de `DROP TABLE`) deixaria um
tombstone permanente no histórico para uma tabela que nunca chegou a produção.

Desenho em
[`specs/2026-09-06-account-pre-hijacking-design.md`](superpowers/specs/2026-09-06-account-pre-hijacking-design.md) §12.

---

### 29 — Recuperação de senha: cinco decisões tomadas no brainstorming

A fatia 12 entrega os dois endpoints do fluxo de recuperação: `POST
/auth/password/forgot` (`202` sempre) e `POST /auth/password/reset` (`204` sem
tokens). Cinco decisões do desenho:

1. **Reset token é valor opaco de 256 bits, não código de 6 dígitos** (spec
   §3.1 / §12.1). `ITokenGenerator.opaque()` + digest sha256 + lookup por índice
   único. Código de seis dígitos (~20 bits) atrás desse endpoint só é seguro com
   TTL curto e teto de tentativas apertado; 256 bits tiram força bruta de cena
   por construção — sem coluna `attempts`, sem `maxAttempts`.

2. **`reset` não auto-loga — responde `204`, sem tokens** (spec §3.3 / §12.3).
   Quem chega ao `reset` está não autenticado, provou só controle da caixa. O
   `change-password` escolheu auto-login porque o chamador **já** segurava access
   token válido; aqui não. O cliente vai para a tela de login e entra com a
   senha nova — o que **prova** a senha recém-definida.

3. **`forgot` envia nada para endereço sem conta** (spec §3.4). Responde `202`
   sempre. O ramo "sem conta" não enumera e o ramo "dentro do cooldown" também
   retorna sem envio — o tempo não separa "existe" de "não existe" de forma
   estável. A *primeira* sonda de um endereço ainda separa — um endereço
   conhecido fora do cooldown paga um round trip SMTP antes do `202` e, com o
   SMTP fora do ar, estoura em `500` enquanto o desconhecido responde `202` —,
   divergências aceitas, herdadas do `register` (mesmo sender nu, mesmo envio
   aguardado) e pendentes do outbox transacional (spec §5.3 / §11).

4. **`reset` roda argon2 só no ramo de token válido** (spec §3.5 / §12.4). Digest
   do token e lookup primeiros; token inexistente / expirado / gasto → `throw
   PasswordResetFailedError()` **sem argon2**. O oráculo de latência "esse token
   era válido" só serve para quem consegue enumerar tokens; com 256 bits, não
   consegue.

5. **`INSERT … ON CONFLICT (user_id) DO UPDATE ... WHERE` para o upsert do
   `forgot`** (spec §12.2). Um token vivo por conta, sobrescrito a cada `forgot`,
   é seguro e mais simples que vários pendentes coexistentes (como no
   pre-hijacking fechado na fatia 11). Cooldown vive na cláusula `WHERE` do
   `DO UPDATE`, não numa leitura anterior — dois `forgot` simultâneos não podem
   ambos passar. Primeira vez que o padrão aparece no repo.

Desenho completo em
[`specs/2026-09-07-password-recovery-design.md`](superpowers/specs/2026-09-07-password-recovery-design.md).

---

### 30 — Cron: `cron.ts` one-shot, registry de jobs por módulo, poda com retenção

> **Emendada em 2026-09-07**, ainda dentro da fatia 13, antes do merge. A versão
> original rodava **todos** os jobs a cada invocação e listava a seleção por
> argv como descartada. O motivo da virada não é cadência, é que **o `cron.ts` é
> global**: com um segundo módulo registrando jobs, uma invocação única obriga
> `billing` a rodar na cadência de `auth`, um job lento de um módulo atrasa a
> manutenção de outro, e o exit code vira um bit só para todos — o alerta diz
> "o cron falhou", não qual módulo. O parágrafo de seleção abaixo é a emenda.

A decisão 10 reservou o entrypoint `main/cron.ts` e nunca o construiu. A fatia da
poda de tokens expirados o materializa, e com ele quatro sub-decisões.

**One-shot + scheduler externo.** `cron.ts` sobe, roda os jobs de manutenção,
loga o resultado de cada um, `exit 0` se todos passaram e `exit 1` se algum
lançou. Quem o agenda é a plataforma. É o padrão de deploy conteinerizado, e
encaixa na decisão 16 (aplicação roda como processo, não como serviço no
compose). O scheduler da plataforma já entrega retry, histórico, alerting e
timezone.

- **Como agendar em produção:** Kubernetes `CronJob` executando `node
  dist/main/cron.js <alvo>`; ou ECS Scheduled Task; ou uma linha de `crontab`
  chamando o mesmo comando. Nada disso mora no repo — cada app derivado escolhe.
- **Em dev não há scheduler.** A poda só roda quando invocada à mão: `node
  --conditions=development --env-file-if-exists=.env --import tsx src/main/cron.ts`.
  Poda é manutenção, não corretude.

**Seleção de alvo por argumento posicional, com nome qualificado pelo módulo.**
O alvo é `módulo:job`, e o argumento é opcional:

```
node dist/main/cron.js                                       # tudo, todos os módulos
node dist/main/cron.js auth                                  # todos os jobs do auth
node dist/main/cron.js auth:prune-expired-refresh-tokens     # um job
```

A qualificação acontece no `run-cron.ts`, **no ponto em que as listas dos módulos
são concatenadas** (`qualify(AUTH_MODULE, container.auth.jobs)`), e não no
módulo: lá o prefixo seria convenção que um autor pode esquecer, e a colisão
entre módulos voltaria. Aqui ela é impossível por construção.

- **Sem argumento roda todos.** Conveniência de dev e de app pequeno com uma
  entrada só. **Custo aceito:** se o scheduler de produção tiver entradas por
  job E sobrar uma invocação sem argumento, as tabelas são varridas duas vezes —
  inofensivo (a poda é idempotente), mas o único indício no log é
  `cron run complete {jobs: 3}` contra `{jobs: 1}`. **Produção nomeia o alvo.**
- **Custo aceito:** agendar por job significa N entradas no scheduler, cada uma
  documentada pelo app derivado. Era o motivo pelo qual a versão original
  descartava o argv; deixou de ser motivo para descartar e virou custo da
  escolha.
- **Alvo inexistente sai `exit 2`** (`CRON_EXIT_BAD_INVOCATION`), não `1`: é task
  definition quebrada, não job quebrado, e um alerta que confunde os dois pagina
  a pessoa errada. O erro carrega a lista de alvos válidos. `CronInvocationError`
  é o tipo que separa isso de um banco fora do ar, que continua saindo `1`.
- **Sem multi-seleção** (`cron.js a b`): precisa de dois, roda duas vezes. Um
  argumento extra é recusado em vez de ignorado em silêncio.
- **A validação roda depois de montar o container**, não antes: o container é a
  fonte única de verdade sobre quais alvos existem, e um typo pagar a abertura de
  um pool é mais barato que manter uma segunda lista em sincronia.

**Descartado — processo longo com `node-cron`/`setInterval`:** auto-contido, mas
traz dependência nova, um processo a mais para manter no ar, e dispara N vezes
sob réplicas sem um lock. É padrão de monólito pequeno sem orquestrador.

**Descartado — `pg_cron`:** contradiz a decisão 10, exige extensão no banco, e
tira a poda do código versionado e testável.

**Registry de jobs por módulo.** Cada módulo expõe `jobs: CronJob[]` na sua fatia
do container; `run-cron.ts` concatena as listas. Módulo novo com job novo não
toca `cron.ts`. É acesso a propriedade da fatia injetada, o mesmo mecanismo de
`verifyAccessToken` — nenhum import entre módulos.

**Descartado — método único `container.auth.pruneExpired()`:** não generaliza
para o segundo módulo com job, nem para o dispatch do outbox.

**Poda com janela de retenção por tabela.** `DELETE ... WHERE expires_at <=
$cutoff`, com `cutoff = now − retention`. Cada tabela tem a sua env var
(`*_PRUNE_RETENTION_SECONDS`, defaults 7 dias / 24 h / 24 h). Uma linha morta
fica investigável por uma janela; `created_at` já era imutável "para ordenação
de poda e auditoria".

**Descartado — deletar no instante da expiração:** tira o rastro de post-mortem.
**Descartado — retenção global única:** 7 dias de tokens de reset mortos é mais
lixo do que o TTL de 30 min justifica. **Descartado — predicado com
`revoked_at`/`consumed_at`:** um predicado único sobre a coluna `NOT NULL` que as
três tabelas têm é o que qualquer leitor entende; o custo é um token revogado
cedo com `expires_at` futuro ficar até `expires_at + retention`, limitado pelo
TTL.

**Fora de escopo:** o outbox transacional. Ele reusa este registry — é mais um
`CronJob` de dispatch —, mas põe o código de verificação em texto claro em
repouso no banco, e o §5.3 da fatia 10 adiou isso de propósito.

Desenho completo em
[`specs/2026-09-07-token-pruning-cron-design.md`](superpowers/specs/2026-09-07-token-pruning-cron-design.md).

---

### 31 — Login com Google: client-driven, verificação de ID token, sem merge silencioso

A fatia 14 entrega `POST /auth/google`. O cliente roda o SDK do Google e manda o
**ID token**; a API verifica a assinatura contra o JWKS público (`jose`,
`createRemoteJWKSet` + `jwtVerify`), **sem client secret**. O fluxo redirect/BFF
(`/start` + `/callback`, com `state`+PKCE e `GOOGLE_CLIENT_SECRET`) fica para uma
fatia futura que reusa o núcleo de vínculo desta — é o padrão para um front web
com backend próprio, mas o client-driven é o que a maioria dos apps mobile faz, é
a entrega menor, e casa com a decisão 12 (corpo, um processo para os dois
clientes) e a decisão 13 (que já previu *receber* um token).

**Tabela `federated_identities`** — `(provider, provider_user_id)` e
`(user_id, provider)` únicos, FK para `users` com `ON DELETE CASCADE`. Não guarda
token do Google, só a identidade; `email_at_link` audita o endereço afirmado no
vínculo sem virar autoridade sobre ele.

**`users.password_hash` passa a aceitar `NULL`** — uma conta federada não tem
senha. `login` já a absorve pelo decoy (`?? dummyHash`); `change-password` ganha
um guard com decoy. Sentinela foi descartada: mentira gravada, frágil no
`argon2.compare`.

**Sem merge silencioso.** Google sobre um e-mail com conta-senha responde
**`409 GOOGLE_LINK_REQUIRES_PASSWORD`**; o cliente repete o request com a senha do
app, que é conferida (argon2 **fora** da transação, §8 do Unit of Work) antes de
vincular. A recusa é **específica** de propósito — seguro só aqui porque o IdP já
provou o endereço (§6, item 3). `email_verified: true` é obrigatório: sem ele o
Google não provou nada, e `InvalidGoogleIdentityError` (401) cobre esse e todos os
outros modos de falha de identidade num erro só.

**`GOOGLE_CLIENT_ID` obrigatório no boot**, como `JWT_SECRET` (decisão 14).
`GOOGLE_JWKS_URI` entra no env com default de produção (padrão do `MAIL_HOST`),
para o teste de integração apontar para um JWKS local via override no `buildApp`.

Resolve os itens 1, 2 e 3 de "Login social / OAuth (Google primeiro)" da §6: sem
troca de e-mail (casa por `sub`); Google ganha de um cadastro pendente (conta
nasce verificada, pendentes apagados no mesmo `uow`); Google sobre conta-senha
exige a senha.

Desenho completo em
[`specs/2026-09-08-google-sign-in-design.md`](superpowers/specs/2026-09-08-google-sign-in-design.md).

---

### 32 — Seed de dev: cenários por módulo, runner no composition root, só banco local

`pnpm db:seed` leva o banco **local** a um estado conhecido. Paridade de uso com
o `db:seed` do byteflow; a estrutura diverge onde as fronteiras daqui exigem.

**Cenários por módulo, fora do container.** Cada módulo publica um `SeedModule`
em `modules/<m>/infra/seeds/`; `main/seeds/runner.ts` os lista à mão
(`SEED_MODULES`), como o `run-cron.ts` lista os jobs, e qualifica os nomes
(`auth:base-users`). Nada de seed entra no container: dado de dev fica fora do
grafo de produção. `**/seeds/**` sai do `dist` pelo `tsconfig.build.json`.

**O contrato mora em `#infra`.** Em `#main` o seed do módulo dispararia
`INFRA-MAIN`; em `#shared`, camada pura, não poderia citar `Database`.

**Escrita por entidade + repositório.** As factories usam `User.create`,
`FederatedIdentity.create`, `PendingRegistration.create` e os repositórios
Drizzle — as invariantes e os mappers valem para o seed como para a API. A única
escrita crua é o `wipe`.

**Uma transação; `wipe` de todos os módulos.** Cada módulo apaga o próprio
namespace (no `auth`, `@seed.local`) em ordem inversa, e só então os cenários
rodam. Todos os módulos, não só os selecionados: sem FK entre módulos
(decisão 24), nenhuma cascata limpa um pelo outro. O `prepare()` de cada módulo
roda antes da transação — é onde o argon2 da senha de seed vai.

**Duas travas de alvo, sem flag de contorno.** Recusa `NODE_ENV=production` e
qualquer host de `DATABASE_URL` fora de `localhost`/`127.0.0.1`/`::1`. A segunda
existe porque `NODE_ENV` tem `development` como default: um shell de servidor
sem a variável passaria pela primeira e plantaria uma conta com senha publicada.
Semear staging, se um dia fizer sentido, é outra decisão.

**Descartados.** `src/seeds/` global (cópia literal do byteflow): cai em
`LAYER-UNKNOWN` e concentra o concreto de todos os módulos num lugar só. Seed via
use cases: exige ler o código de seis dígitos do e-mail, não alcança conta
só-Google sem fake, e não cabe numa transação — cada use case abre a sua, e o
runner recusa aninhamento.

Desenho completo em
[`specs/2026-09-14-dev-database-seed-design.md`](superpowers/specs/2026-09-14-dev-database-seed-design.md).

---

## 3. Defaults assumidos (não debatidos, abertos a objeção)

| Tema | Escolha | Nota |
|------|---------|------|
| Runtime | Node LTS, com `.nvmrc` + `engines` | |
| Package manager | **pnpm** | node_modules estrito pega phantom dependency — num boilerplate copiado N vezes, isso vale muito |
| Módulos | **ESM** | |
| Validação | **Zod** + `fastify-type-provider-zod` | Mesmo schema vira validação, tipo do handler e OpenAPI; serve também para env e DTO. TypeBox seria mais rápido e mais nativo do Fastify, mas Zod ganha em ubiquidade |
| Logging | **pino** | Já é o logger nativo do Fastify |
| Driver Postgres | **postgres.js** | Baixo risco, trocável |
| Hash de senha | **argon2id** | |
| Test runner | **Vitest** | Suporta ESM e TypeScript sem transpilação extra, e a separação unit/integração (decisão 09) sai em duas configs |
| Nomenclatura de arquivo | `kebab-case.ts` | Implementação concreta leva prefixo da tecnologia (`drizzle-users-repository.ts`); contrato não (`users-repository.ts`) |

---

## 4. Regras de código derivadas

Regras que saíram diretamente da análise de risco, não de preferência de estilo.

**R1 — Repositório usa só a API core do Drizzle. Nunca `db.query.*`.**
O roadmap v1 tem "Relational Queries V2 API". Repositório escrito com
`db.query.users.findMany({ with: ... })` seria reescrito quando o V2 chegar. A API
core (`select()/join()/where()`) não é tocada. Como já existe mapper para entidade
de domínio, o select explícito sairia de qualquer jeito — a mitigação é de graça.

**R2 — Coluna sempre nomeada explicitamente.**
`id: uuid('id')`, nunca depender de inferência de casing. `casing-rework` é branch
ativa e o roadmap prevê aliases opcionais de coluna. Nomeando explicitamente,
nenhum rework move o schema.

**R3 — Não cortar um "1.0 do boilerplate" para outros times antes do GA do
Drizzle.**

> **Revisada em 2026-08-25.** A evidência original desta regra já venceu. Ela
> citava o item de roadmap "Migrate to folder v3, remove journal" como risco
> futuro que atingiria a pasta `drizzle/` de todo app derivado. **Isso já
> aconteceu**: o `1.0.0-rc.4` grava uma pasta por migration
> (`<timestamp>_<nome>/migration.sql` + `snapshot.json`), sem journal, e o
> migrator **recusa ativamente** o formato antigo — ele lança
> `"We detected that you have old drizzle-kit migration folders"` se encontrar
> `meta/_journal.json`. Este projeto nasceu do lado novo, então o custo previsto
> foi zero.
>
> Calibração que vale registrar: a previsão estava **certa** — o formato mudou
> mesmo. A mitigação é que foi desnecessária, por sorte de timing.

A regra **continua valendo**, sobre outro fundamento: `1.0.0-rc.4` é release
candidate, pinado exato pela decisão 07, e o roadmap ainda tem itens que tocam
código nosso — "Relational Queries V2 API" (mitigado pela R1), "down migrations"
(assumido pela R4) e a branch `casing-rework` (mitigada pela R2). O argumento não
é mais "a pasta vai mudar de formato"; é que ainda não existe versão estável.

**R4 — Migrations são forward-only.**
No roadmap, "down migrations" aparece **depois** do marcador `V1 RELEASE STREAM`,
ou seja, o v1 sai sem elas. Não é bloqueador (forward-only + expand/contract é a
prática moderna), mas precisa ser escolha documentada do boilerplate, não
descoberta em incidente.

**R5 — Comunicação entre módulos só via Application ou Domain.**
Herdado do `ARCHITECTURE.md` e mantido integralmente. Foi avaliado como o ponto
mais forte do documento original: esse tipo de regra normalmente só aparece depois
que o time já bagunçou tudo com chamadas cruzadas.

> **Regra de ouro:** a comunicação entre módulos acontece sempre na camada de
> use case ou através de contratos de domínio. **Nunca** invocar o handler HTTP de
> outro módulo, nem fazer chamada HTTP interna ao próprio servidor.

Três abordagens, escolhidas conforme a complexidade — conteúdo preservado aqui
e replicado no `ARCHITECTURE.md` §6:

1. **Injeção do contrato de repositório** *(recomendado e mais comum)* — injetar
   `IProductsRepository` direto no use case do módulo chamador. Baixo acoplamento,
   execução em memória e teste unitário trivial com repositório in-memory.
2. **Reuso de use case** — quando a interação envolve efeito colateral ou regra de
   domínio complexa (reservar estoque, aplicar cupom), injetar e executar o use
   case do módulo alvo em vez do repositório.
3. **Eventos de domínio** — para desacoplamento completo, ou preparando extração
   futura para microserviço. O chamador persiste em estado `PENDING` e despacha o
   evento; o módulo alvo reage e despacha o resultado; o chamador atualiza o
   estado.

**Antipadrões explicitamente proibidos:**

- ❌ **Chamada HTTP interna** — `axios.get('/api/products/123')` dentro do mesmo
  monólito. Adiciona latência, overhead de rede e ponto de falha sem necessidade.
- ❌ **Reuso de handler HTTP** — chamar o handler de outro módulo dentro de um
  fluxo. Handler apenas traduz entrada HTTP em parâmetro de use case e formata a
  resposta.
- ❌ **Importar `infra/` de outro módulo** — pegar `DrizzleUsersRepository` em vez
  do contrato. Coberto pela linha `module-infra` da regra de fronteira (decisão
  02), cuja única exceção declarada é `ensure-authenticated`.

**R6 — Só `infra/config/env.ts` lê `process.env`.**
Decorre da decisão 14 e fecha o único furo dela. Se o módulo lesse `process.env`
direto, esquecer de registrar seu schema no merge passaria despercebido: a
variável simplesmente não seria validada e chegaria `undefined` em runtime. Com o
acesso restrito e a config injetada tipada, esquecer o merge vira **erro de
compilação**, não bug de produção. Vale lint.

**R7 — Use case não produz valor não determinístico.**
Nada de `new Date()`, `Date.now()`, `Math.random()` ou `crypto.randomUUID()` dentro
da camada pura. Tempo e aleatoriedade entram por contrato (`IClock` e afins,
decisão 21). Sem isso, o teste unitário da rotação de refresh — expiração, janela
de graça, detecção de reuso — é impossível de escrever de forma determinística.

---

## 5. Estrutura resultante

```text
src/
├── modules/
│   └── auth/
│       ├── entities/                    # puro
│       ├── value-objects/               # puro
│       ├── repositories/                # SÓ contratos, + unit-of-work.ts (22)
│       ├── providers/                   # SÓ contratos: hash, token signer (21)
│       ├── use-cases/                   # puro (+ .spec.ts colocado)
│       ├── dtos/
│       ├── errors/
│       ├── config.ts                    # schema Zod das env vars do módulo (14)
│       ├── container.ts                 # factory do container do módulo
│       └── infra/                       # toca o mundo externo
│           ├── drizzle/
│           │   ├── schema/               # 1 arquivo por tabela DESTE módulo
│           │   │   └── users.ts
│           │   ├── user-mapper.ts       # row <-> entidade (20)
│           │   ├── drizzle-users-repository.ts
│           │   └── drizzle-unit-of-work.ts
│           ├── in-memory/
│           │   └── in-memory-users-repository.ts
│           ├── providers/               # argon2-hash-provider, jwt-token-signer
│           └── http/
│               ├── endpoints/           # 1 arquivo = schema + handler + rota
│               ├── middlewares/
│               └── routes.ts            # agregador fino
│
├── infra/                               # infra GLOBAL, sem dono
│   ├── config/env.ts                    # merge + validação no boot (14)
│   ├── database/
│   ├── http/
│   │   ├── server.ts
│   │   └── error-handler.ts             # único lugar que sabe de status (13)
│   ├── observability/                   # context.ts (ALS) + logger.ts (15)
│   └── providers/                       # system-clock.ts (21)
│
├── shared/
│   ├── errors/                          # app-error.ts + taxonomy.ts (13)
│   └── providers/                       # contratos transversais: IClock (21)
│
└── main/                                # entrypoints + composition root
    ├── container.ts
    ├── http.ts
    ├── worker.ts
    └── cron.ts

tests/integration/                       # suíte com Postgres real (09, 17)
drizzle/                                 # migrations geradas, forward-only (R4)
drizzle.config.ts                        # agrega os schemas por glob (06)
```

---

## 6. Decisões em aberto

**Os seis blocos do roteiro estão fechados.** O que resta são decisões menores
mas ainda não tomadas, agrupadas pelo momento em que precisam ser resolvidas.

**Nada bloqueia mais o início da implementação** — as três pendências que
bloqueavam (lint de fronteira, build e path alias, mappers) viraram as decisões
18, 19 e 20.

**Podem esperar o primeiro módulo existir:**

- ~~**Superfície pública do módulo**~~ — **RESOLVIDA em 2026-08-27**, pela fatia
  do login. O guard é infra global genérica e recebe o verificador **injetado**
  (`makeAuthGuard(verify)`), então `infra/http/auth-guard.ts` não importa nada de
  `#modules/*` e nenhum módulo importa `auth` para se proteger. A exceção
  declarada no lint que a auditoria de 2026-08-20 previu não é necessária.
  Desenho em [`specs/2026-08-27-login-design.md`](superpowers/specs/2026-08-27-login-design.md) §4.3.
- ~~**Rate limiting e proteção contra brute force**~~ — **RESOLVIDA em
  2026-09-02.** Entrou teto por endereço com `@fastify/rate-limit` (global de
  300/min, e 10/min no login), `TRUST_PROXY` explícito e `clientIpKey`. Resposta
  `429` no envelope, com `code` próprio e **sem oitava categoria** na taxonomia:
  o 429 nasce no transporte, então mora junto do 4xx do Fastify (decisão 13).

  **A contagem de falha de autenticação NÃO entrou, e isso é decisão.** Só a
  aplicação sabe que a senha estava errada, mas implementá-la exigiria porta de
  store, política de dois baldes na camada pura, teto de memória com política de
  despejo e um caminho próprio para Redis — para reimplementar, pior, o que a
  borda já faz na metade grossa do problema. Fica delegada à borda
  (Cloudflare/WAF/ALB) e ao custo do argon2, medido em 7,3 ms e 19 MB por
  tentativa.

  **O que a escolha custa, dito claramente:** uma conta de e-mail conhecido e
  senha fraca pode ser quebrada por uma botnet paciente — cada IP gasta 10/min,
  e mil IPs somam dez mil tentativas por minuto — e **nada no servidor vai
  notar**. A proteção de borda também só vale para o tráfego que passa por ela:
  se o IP de origem for alcançável direto, o atacante pula tudo.

  **Gatilho para reabrir:** o primeiro app derivado que trate dado sensível
  (saúde, financeiro), ou o primeiro incidente de conta comprometida por força
  bruta.

  A política do par IP + e-mail proposta pela spec do login §14.3 foi analisada
  e **descartada com ela**: o par sozinho não detém ataque distribuído (mil IPs
  são mil baldes), e o balde por e-mail que o deteria é vetor de DoS contra a
  vítima. Desenho e alternativas recusadas em
  [`specs/2026-09-02-rate-limiting-design.md`](superpowers/specs/2026-09-02-rate-limiting-design.md).
- ~~**A janela de graça permite bifurcar uma família sem detecção.**~~
  **RESOLVIDA em 2026-09-01**, pela saída 3 abaixo, com a exigência de
  single-flight escrita na decisão 11. O registro do problema fica porque as
  três saídas continuam sendo o mapa de quem reabrir isto. Texto original:
  adiado conscientemente em 2026-09-01. Dentro dos 30s, reapresentar o token já
  rotacionado emite um par novo **sem** matar o sucessor anterior, então um
  token roubado usado nessa janela cria uma segunda cadeia viva na mesma
  família e a detecção de reuso nunca dispara para nenhuma das duas.
  **Não confundir com multi-device:** cada login abre família própria, e é isso
  que sustenta vários aparelhos — fechar o fork não afeta isso.
  Três saídas, e a decisão 11 hoje manda a primeira:
  1. emitir par novo e não tocar no irmão (atual) — perdoa resposta perdida,
     permite o fork;
  2. falhar 401 dentro da janela sem revogar a família — é o que o
     `~/projects/byteflow` faz, e o comentário dele nomeia o fork como o motivo;
     fecha o buraco ao custo de reintroduzir o logout aleatório;
  3. emitir par novo **e** revogar o sucessor anterior — um ativo por família:
     perdoa a resposta perdida *e* faz o fork disparar detecção na próxima
     rotação da vítima. Custo: um duplo-toque genuíno em que o cliente já
     recebeu o sucessor e mesmo assim reenvia o antecessor mata o token que ele
     tem. É a candidata mais forte se isto for reaberto.
- **A sessão não tem teto absoluto.** Os 60 dias são deslizantes, então um
  cliente que dê refresh toda semana nunca reautentica. Rotação e detecção de
  reuso cobrem roubo, então não é furo — é decisão de produto nunca tomada. A
  saída usual é um `max_lifetime` por família.
- **Colisão de nome de tabela entre módulos.** Nada impede dois módulos
  declararem `users`. O `drizzle-kit` junta os globs e gera a migration com as
  duas — e o erro aparece no `db:migrate`, não no lint. Saídas possíveis:
  disciplina, prefixo por módulo (`auth_users`), ou um schema do Postgres por
  módulo (`pgSchema('auth')`). Decidido ficar em `public` por ora, já que
  `ALTER TABLE ... SET SCHEMA` torna a migração posterior barata.

**Escopo de produto, não de arquitetura — decidir o que entra no boilerplate:**

- ~~Verificação de e-mail~~ — **RESOLVIDA pela fatia 10** (decisões 13, 25 e 26)
  e **fechada contra account pre-hijacking pela fatia 11** (decisões 27 e 28): a
  conta passou a nascer na confirmação, com a senha do request de confirm.
  Throttle de `confirm` por e-mail e deleção de conta varrendo os pendentes
  continuam fatias próprias. ~~Recuperação de senha~~ — **RESOLVIDA pela fatia
  12** (decisão 29): `POST /auth/password/forgot` e `POST /auth/password/reset`
  entregues, reusando a infraestrutura de e-mail e o padrão de tabela com
  hash/expiração/uso único.
- ~~**Login social / OAuth (Google primeiro)**~~ — **RESOLVIDA pela fatia 14
  (decisão 31).** `POST /auth/google` client-driven: a API verifica o ID token
  contra o JWKS do Google, sem client secret. Tabela `federated_identities`,
  `users.password_hash` nulável, e os três itens abaixo implementados. O que fica
  para fatias próprias: fluxo redirect/BFF, desvincular provedor, definir a
  primeira senha numa conta só-Google, listar provedores no `/me`, restrição de
  domínio `hd`. O registro dos três itens fica porque continua sendo o mapa do
  desenho:

  1. **Não haverá troca de e-mail.** Com identidade federada o endereço deixa de
     ser um campo que o usuário possui e passa a ser **asserção do provedor**.
     Um endpoint de troca criaria a pergunta "quem é a autoridade, o IdP ou a
     nossa coluna?", que não tem resposta boa. O endpoint sai do roteiro; não é
     omissão.
  2. **Sign-in do Google sobre um cadastro pendente e não confirmado: o Google
     ganha e a conta nasce verificada.** O IdP provou o endereço; o pendente não
     provou nada. Os pendentes daquele endereço são descartados **de modo que
     não possam mais definir senha depois** — um pendente que sobrevivesse e
     ainda aplicasse a senha dele na confirmação seria o sequestro da fatia 11
     por outra porta.
  3. **Sign-in do Google sobre conta verificada com senha: recusa o merge
     silencioso e exige a senha cadastrada**, e só então vincula a identidade em
     definitivo. Merge silencioso é a variante *Classic-Federated Merge* do
     pre-hijacking: o atacante cadastra o endereço da vítima com senha, a vítima
     entra com Google meses depois, o app funde, e a senha do atacante continua
     valendo.

  **Uma assimetria a preservar, e não "corrigir".** A recusa do item 3 pode ser
  **específica** — "este endereço já tem conta com senha" — sem virar oráculo de
  enumeração, porque no callback do OAuth o IdP já provou que quem está ali é o
  dono do endereço. É a única porta do `auth` onde contar a verdade não vaza
  nada, e destoa de propósito do `202` genérico do `register`.

  Ver também a ressalva de formato de erro na decisão 13: o endpoint de token do
  OAuth tem corpo de erro mandatório pela RFC 6749 e fica fora da convenção
  deste projeto.
- **RBAC / permissões — decisão tomada de NÃO entrar no boilerplate.**
  Reclassificada em 2026-09-17: não é decisão de arquitetura pendente, é
  escopo de produto — pelo mesmo motivo que fechou a discussão do outbox
  genérico (§2, decisão 33): sem um segundo consumidor real, não há como
  validar a forma certa, e "quem pode fazer o quê" varia por produto de um
  jeito que "como não vazar sessão" não varia. Um papel único (`admin`/`user`)
  seria simples demais para servir de verdade; papéis com permissões
  associadas seria decisão tomada sem produto nenhum para validar contra.
  **Gatilho para reabrir:** o primeiro app derivado que precisar de acesso
  diferenciado por usuário — e a decisão certa então depende do que ESSE
  produto precisa (papel único? por recurso? por organização?), não do que
  este documento adivinhar hoje.
  Continua valendo o registro do trade-off, para quando a decisão for
  retomada: se o papel for para dentro do JWT (decisão 11), mudança de
  permissão só vale no próximo refresh — janela de até 1h, a mesma latência
  de revogação que a decisão 11 já aceitou para autenticação, agora
  valendo também para autorização.
- Multi-tenancy

---

### 33 — Outbox transacional: três avisos pós-commit, estado por timestamp, retry com teto simples

Fecha o furo "crash entre o `COMMIT` e o envio SMTP perde o e-mail em silêncio",
para os três avisos que o encerram: `passwordChangedEmail`,
`passwordResetCompletedEmail`, `googleAccountLinkedEmail`.

**Escopo deliberadamente parcial.** `verificationEmail` e `passwordResetEmail`
seguem fora — carregam segredo em texto claro, e colocar a linha em repouso no
banco até o despacho é exatamente o motivo que adiou o outbox inteiro na fatia
10. `accountAlreadyExistsEmail` também fica fora: sem escrita transacional
precedente, não há buraco de atomicidade ali para fechar.

**Estado por timestamp nulável, não enum.** `dispatched_at`/`failed_at` seguem
o mesmo idioma de `consumed_at`/`revoked_at`.

**Retry: contador simples com teto, sem backoff explícito.** O intervalo do
scheduler externo que já invoca `cron.ts` (decisão 30) cumpre esse papel.

**Rejeitados:** um outbox genérico em `shared/`, antes de um segundo módulo
para validar a forma certa (YAGNI); um worker de longa duração com
LISTEN/NOTIFY do Postgres em vez do poll one-shot do `cron.ts` (contradiria a
decisão 16 e o modelo one-shot da decisão 30).

Desenho completo em
[`2026-09-15-transactional-outbox-design.md`](superpowers/specs/2026-09-15-transactional-outbox-design.md).

---

### 34 — Throttle de `confirm` por e-mail: o cooldown de reenvio passa a valer também sobre pending esgotado

Fecha o item "Throttle de `confirm` por e-mail" do `TODO.md`. Sem isso, esgotar
as cinco tentativas de um `pending_registration` liberava a criação de outro na
hora: o cooldown de 60s (`EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`) só se
aplicava a um pending que ainda passasse em `isUsable` (que exige `attempts <
maxAttempts`), então um atacante nunca precisava esperar — bastava esgotar e
chamar `register` de novo. Distribuído em vários IPs, o teto por endereço da
decisão de rate limiting (§6) não segurava isso.

**Rejeitado: contador de falhas por e-mail com bloqueio.** É a saída óbvia,
mas reproduz o padrão já descartado em §6 para o rate limiting do login — um
balde por e-mail que bloqueia dá a quem só conhece o endereço da vítima um
jeito de trancá-la de fora, só que aqui travando o cadastro em vez do login.

**O que entrou:** o cooldown de `RegisterUserUseCase` passa a olhar o pending
mais recente da fila (`findUnconsumedByEmail`, mais recente primeiro), sem
filtrar por `isUsable`. Esgotado ou não, um código pedido há menos de 60s
ainda segura um pedido novo. Isso limita qualquer atacante a cinco chutes por
e-mail a cada 60s, **de qualquer IP** — sem bloqueio novo: o pior caso para o
dono legítimo é o mesmo que já existia ao clicar "reenviar" duas vezes
seguidas.

**Custo aceito:** um atacante que já sabe o e-mail da vítima ainda consegue
atrasar a confirmação dela em até 60s por rodada — não é bloqueio indefinido,
é o mesmo atraso que o cooldown já impunha ao dono legítimo antes desta fatia.

O parâmetro `maxAttempts` do construtor de `RegisterUserUseCase` foi removido
por ter ficado sem uso; `RequestEmailVerificationUseCase` (o endpoint de
reenvio explícito, que só reemite sobre um pending ainda usável e nunca cria
linha nova) continua precisando do seu, sem mudança. Sem migração, sem
variável de ambiente nova: reusa `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`.

---

### 35 — Listar sessões ativas: sem `GROUP BY`, sem info de dispositivo, sem flag de "sessão atual"

Fecha o item "Listar sessões ativas" do `TODO.md`. `GET /auth/sessions`
(Bearer, guardado como `/me`) devolve uma entrada por família de refresh token
com linha ainda viva.

**Sem `GROUP BY`.** A rotação sempre revoga a linha que substitui na mesma
escrita (decisão 11), então uma família tem no máximo uma linha não revogada
a qualquer instante — e essa linha já É o estado atual da sessão. A query é
`WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`, plana.

**Sem informação de dispositivo, de propósito.** `refresh_tokens` não tem
`ip`/`user_agent`/`last_used_at` — isso é o item separado "Contexto de
dispositivo em `refresh_tokens`" da auditoria de 2026-09-07 (§6, tabela da
auditoria), que exige migration. Sem ele, a resposta é só `{ id (family_id),
createdAt, expiresAt }`: dá pra saber **quantas** sessões existem e desde
quando, não **qual** é qual.

**Sem flag de "sessão atual".** Não é derivável só do access token: o guard
só enxerga o `sub` do JWT, nunca o `family_id` — que nem é devolvido ao
cliente em nenhuma resposta hoje. Marcar "essa sou eu" exigiria também ler o
refresh token/cookie nesta rota GET, misturando os dois mecanismos de
transporte fora do padrão do resto do módulo. Fica para quando (se) houver um
pedido concreto.

Sem migração, sem variável de ambiente nova, sem spec dedicado — mudança
pequena o bastante para caber inteira nesta entrada.

---

### 36 — Invalidação de sessão no vínculo do Google, fechando a última rota sensível sem essa defesa

Fecha o item "Invalidar sessões + notificar o dono na verificação" do
`TODO.md`. O texto original vinha do §4.4 do handoff da fatia 11 — na época,
antes da conta nascer só na confirmação e antes do login social existirem, a
"verificação" em questão era o `confirm-email`. Hoje esse ponto não se aplica
mais ali: uma confirmação sempre cria uma conta nova, e não existe sessão
anterior pra derrubar.

**Reinterpretação, verificada no código, não suposta:** das três rotas que
mudam algo sensível numa conta já existente, duas já tinham a defesa —
`change-password.ts` e `reset-password.ts` já chamavam
`refreshTokens.revokeAllForUser` e já mandavam aviso por e-mail (fatia 16,
outbox). A terceira, `SignInWithGoogleUseCase` no ramo que vincula Google a
uma conta que já tinha senha, já mandava o aviso (`googleAccountLinkedEmail`,
decisão 31) mas nunca derrubava as sessões existentes. Era a única porta sem
essa segunda trava — se uma senha vazada fosse usada pra plugar um Google
como porta dos fundos, o dono era avisado, mas o invasor continuava logado
pelas sessões que já tinha.

**O que entrou:** uma chamada a `refreshTokens.revokeAllForUser(existing.id,
now)` dentro da mesma transação que salva o vínculo, na mesma ordem que
`change-password.ts` já usa e pela mesma razão — ANTES de salvar a sessão
nova, porque `revokeAllForUser` só derruba linhas com `revoked_at IS NULL` e,
feito depois, derrubaria a sessão que a própria chamada acabou de abrir.

Sem migração, sem variável de ambiente nova, sem spec dedicado.

---

### 37 — Deleção de conta: hard delete, apoiado na cascata que o schema já declara

`DELETE /auth/me` apaga a linha de `users` de verdade. As FKs com
`onDelete: 'cascade'` — escritas antes desta fatia — levam junto
`refresh_tokens`, `federated_identities` e `password_reset_tokens`, e é isso
que **fecha também o item "Revogação por usuário deletado/banido"** sem código
próprio: um refresh de conta apagada não acha linha e já responde 401.

**Hard delete, não soft delete.** O schema já assumia isso: cascata só dispara
quando a linha-pai some, e com soft delete as três tabelas ficariam com linhas
vivas — inclusive refresh tokens rotacionando — apontando para uma conta que o
app considera morta.

**Sem tabela de eventos de auditoria.** A trilha de auditoria já é pendência
adiada, com gatilho próprio, desde a auditoria de 2026-09-07. Criar uma tabela
agora só para a deleção resolveria esse problema maior pela metade e para um
evento só — o mesmo erro que a decisão 33 e a reclassificação do RBAC
evitaram. Quando o gatilho disparar, a deleção é um dos eventos a capturar.

**Duas escritas explícitas, porque a cascata não as alcança.**
`pending_registrations` é indexada por e-mail e não tem FK (um pendente nasce
antes de existir conta): um irmão não consumido sobreviveria e confirmaria uma
conta NOVA no mesmo endereço. Varrido com `deleteAllByEmail`, que já existia
desde a fatia 14. O aviso de deleção também não tem FK, e é isso que o deixa
sobreviver à conta que ele descreve — gravado no outbox na mesma transação.

**Confirmação em um passo, com a senha atual.** Molde de `change-password.ts`,
não o de recuperação de senha: um segundo passo não torna a ação reversível, só
a atrasa, e custaria tabela, TTL e cooldown novos repetindo infra existente.
Conta só-Google apaga com a sessão válida — não tem senha a reapresentar, e a
fatia que define a primeira senha numa conta federada segue fora do roteiro.

Desenho completo em
[`2026-09-18-account-deletion-design.md`](superpowers/specs/2026-09-18-account-deletion-design.md).

---

## 7. Pendências de manutenção

- [x] `ARCHITECTURE.md` reformatado (2026-08-19) — o bloco da árvore de
      diretórios não estava fechado e vazava sobre o resto do arquivo, os títulos
      de seção eram texto solto e os exemplos de código não estavam em fence.
      Só formatação; nenhum conteúdo alterado.
- [x] `ARCHITECTURE.md` reescrito em module-first (2026-08-20), preservando o
      fluxo de execução, as três abordagens de comunicação entre módulos e os
      antipadrões. Validado por duas auditorias independentes.
- [x] Repositório git inicializado (2026-08-19).
- [x] Documentos versionados em git desde 2026-08-19.

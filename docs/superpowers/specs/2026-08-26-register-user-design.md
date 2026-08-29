# Fatia 2 — `POST /auth/register`

> **Status:** desenho aprovado em 2026-08-26, pronto para virar plano de implementação.
> **Fatia anterior:** [`2026-08-25-users-schema-first-migration-design.md`](2026-08-25-users-schema-first-migration-design.md)

## 1. Objetivo

Entregar o primeiro corte vertical da aplicação: um usuário se cadastra por HTTP,
a senha é hasheada, e a linha chega ao Postgres atravessando todas as camadas que
o `ARCHITECTURE.md` descreve.

A fatia 1 provou o pipeline `db:generate → SQL commitado → db:migrate → CI` com
uma tabela e zero código de aplicação. Esta fatia prova o **desenho**: cinco
decisões que estão escritas há semanas e nunca foram executadas.

| Decisão | Enunciado | Situação antes desta fatia |
|---|---|---|
| 02 | Módulo achatado, `infra/` separado | só existia `infra/drizzle/schema/users.ts` |
| 08 | Container manual tipado | nenhum container existe |
| 20 | Mapper como função pura em `infra/` | nenhum mapper existe |
| 21 | Providers: contrato no puro, impl. em `infra/providers/` | nenhum provider existe |
| 23 | O plugin do módulo recebe a fatia dele do container | nenhum plugin de módulo existe |

O módulo `auth` hoje é **um arquivo, e ele é infra**. Depois desta fatia ele é um
módulo.

## 2. Escopo

### Entra

Cadastro de conta: `POST /auth/register` recebe e-mail e senha, devolve `201 { id }`.

### Não entra, e por quê

- **Login e tokens** — decisão 11 inteira (tabela `refresh_tokens`, rotação,
  janela de graça de 30s, Unit of Work, cookie `httpOnly` da decisão 12).
- **Verificação de e-mail** — fatia 4, **não** a próxima. Ver §3, e o argumento
  logo abaixo: quem recusa quem não verificou é o login, então a verificação
  construída antes dele seria uma trava sem porta. A fatia 3 é o login
  ([`2026-08-27-login-design.md`](2026-08-27-login-design.md)).
- **Rate limiting** — decisão em aberto. Ver §14.

### A ordem das fatias, e o motivo dela

O fluxo final pretendido é `register → verificar e-mail → login`. Três ordens de
construção foram avaliadas:

| Ordem | Custo |
|---|---|
| register sozinho | **escolhida** |
| register + verificação inteira | 9 decisões inéditas de uma vez; `IMailer` desenhado às pressas sem provedor definido |
| register + login | puxa a decisão 11 inteira; a maior das três |

**O argumento que decidiu:** marcar `email_verified_at` só tem efeito se alguém
**recusar** quem não verificou, e quem recusa é o login. Construir a verificação
antes do login entrega uma trava que não tranca porta nenhuma — uma feature de
segurança inerte, que é pior que uma ausente porque parece proteção.

## 3. A verificação de e-mail, e por que o register não vai emitir o código

O byteflow emite o código **dentro** do register, na mesma transação. Aqui o
register **não** vai emitir: quem emite é um `POST /auth/verify-email/request`
separado, na fatia seguinte.

O motivo não é preferência. É que o próprio byteflow **já teve que extrair** esse
caminho:

```
byteflow/apps/api/src/modules/identity/application/
├── issue-email-verification.ts      ← o serviço compartilhado
├── register-user.ts                 ← chama issueFor dentro da transação
└── request-email-verification.ts    ← o caminho de reenviar
```

Reenviar código é obrigatório em app real — o e-mail cai no spam, o usuário fecha
o app. Então o endpoint separado existe de qualquer jeito. Emitindo pelo register
**também**, o código de emissão nasce em dois chamadores; emitindo só pelo
endpoint dedicado, nasce em um.

**A consequência que importa para esta fatia:** o `register` escrito aqui **nunca
precisará ser reescrito** quando a verificação chegar. Ele não ganha Unit of Work,
não ganha mailer, não ganha gerador de código.

Custo aceito: uma chamada a mais no cadastro do app mobile — invisível, encadeada
igual ao `register → login`.

## 4. Decisões tomadas neste brainstorming

### 4.1 — A entidade: campos privados + mapper em `infra/`

A decisão 20 e o byteflow discordam neste ponto, e a discordância é real.

**Escolhido:** `User` com campos `#` privados e getters; a conversão para row mora
em `modules/auth/infra/drizzle/user-mapper.ts`, como função pura.

**Descartado — snapshot na entidade (byteflow):** `toSnapshot()` / `fromSnapshot()`
com um tipo `UserSnapshot` na camada pura. Mais curto, um arquivo a menos, e roda
em quatro módulos do byteflow sem incidente.

Perdeu por um motivo específico: **a economia de código dela é o acoplamento.**

```ts
return row ? User.fromSnapshot(row) : null
//                                ↑
//   `row` é `typeof users.$inferSelect`, tipo gerado pelo Drizzle.
//   Compila porque é estruturalmente compatível com UserSnapshot.
```

A brevidade vem de deixar a row do Drizzle entrar direto na camada pura. Montando
o snapshot campo a campo no repositório para evitar isso, o mapper é reinventado
ali dentro, sem nome. E `UserSnapshot` na camada pura é literalmente o que a
decisão 20 nomeia como o custo a evitar:

> *"mora em `infra/` porque **conhece o formato da row** — colocar a conversão na
> entidade faria a camada pura saber de persistência, furando a decisão 02."*

**O que foi preservado do byteflow:** os campos `#`. Isso não é estilo — é
garantia de runtime. Campo `#` é não-enumerável, então `JSON.stringify(user)`
devolve `{}` e o `passwordHash` não vaza por serialização acidental.

**Achado que tornou isso concreto:** `REDACT_PATHS` redige `password` e
`*.password`, mas **não redige `passwordHash`** — o redact do pino casa nome de
chave exato. Uma entidade com campo público `passwordHash` vazaria o hash em log
hoje. O caminho HTTP já está coberto (o `serializerCompiler` valida a resposta
contra o schema Zod e remove chave não declarada); o buraco era o log. Esta fatia
corrige o `REDACT_PATHS` **e** fecha o furo estruturalmente com os campos `#`.

### 4.2 — Validação em dois lugares, com uma fonte da verdade para os números

**Escolhido:** o schema Zod do endpoint carrega a política completa, e os value
objects `Email` e `Password` repetem a mesma política. As constantes são
exportadas dos VOs e **importadas pelo endpoint** — um lugar só define os valores.

Isso é legal pela regra de fronteira: o endpoint é `module-infra` e pode importar
`pure`.

Os dois pontos de enforcement têm consumidores diferentes:

- **Zod, no boundary** — dá ao cliente mobile o `400` com o array `details` por
  campo que a decisão 13 já constrói, e publica a política no OpenAPI.
- **VO, no domínio** — pela decisão 10 o mesmo use case roda em worker, cron e
  seed, onde não existe Zod nenhum. Sem o VO, o use case só é seguro quando
  chamado por HTTP.

A duplicação tem motivo escrito, e os **números** não podem divergir — são a
fonte compartilhada da verdade, importada em um lugar só.

O **formato** do e-mail é outra história: `z.email()` no schema exige domínio
com ponto e TLD de 2+ caracteres e recusa pontos consecutivos; `Email.create`
aceita qualquer string com exatamente um `@` e os dois lados não-vazios (ex.:
`a@b`). Isso é deliberado, não um descuido — o Zod é estritamente mais
restritivo, então nunca rejeita algo que o VO aceitaria, e é por isso que
`InvalidEmailError` continua **inalcançável por HTTP** (ver §10). Mas o VO
existe para os entrypoints de worker/cron/seed da decisão 10, e esses aceitam
`a@b`: linhas que nenhum cliente HTTP jamais conseguiria criar.

### 4.3 — Política de senha: mínimo 8, máximo 128, letra + dígito + não-alfanumérico

Igual ao byteflow.

**Registrado para calibração:** o **NIST SP 800-63B** (revisão de 2024) recomenda
o contrário — o verificador **não deve** impor regras de composição, porque elas
empurram o usuário para `Senha123!`, que é previsível; a recomendação de lá é
comprimento maior mais checagem contra listas de vazamento. A escolha aqui foi
consciente, pelo alinhamento com a expectativa de produto e de tela de cadastro.
Um app derivado que queira seguir o NIST edita **um arquivo**: `password.ts`.

O teto de 128 não é estético: barra DoS de CPU/memória no argon2.

### 4.4 — Um padrão único de composição, não três `.regex()`

Verificado empiricamente antes de escrever (§13): três `.regex()` separados
produzem `INVALID_FORMAT` para as três regras, **e entradas duplicadas** quando
mais de uma falha. O cliente não consegue distinguir "falta número" de "falta
símbolo".

`.refine()` seria pior: cai no code `custom`, que o `validation-issues.ts` mapeia
para `INVALID_VALUE` de propósito, para não vazar que existe um refine no schema.

**Escolhido:** um padrão único com lookaheads, exportado do VO e usado pelos dois
lados. Um `INVALID_FORMAT` limpo, e o comprimento continua granular (`TOO_SMALL` /
`TOO_BIG`, que se comportam bem).

O feedback por regra ("falta um número") é trabalho do cliente — o byteflow faz
exatamente isso em `apps/web/src/features/auth/lib/password.ts`, validação viva na
tela. O servidor recusa; a tela ensina.

#### A flag `s` é obrigatória, e o OpenAPI a descarta

Verificado (§13): sem a flag, `"abc\n123!"` — que satisfaz a política inteira —
seria **recusada**, porque `.` não atravessa `\n` e o padrão está ancorado em `^`.
Quebra de linha é caractere legítimo de senha, do mesmo modo que espaço.

O Zod honra a flag em runtime. O **OpenAPI gerado, não**:

```json
"pattern": "^(?=.*[a-zA-Z])(?=.*\\d)(?=.*[^a-zA-Z0-9])"
```

`pattern` do JSON Schema não tem conceito de flag, então ela some — sem erro e sem
aviso. O padrão publicado é portanto **mais estrito** que o servidor: um cliente
que valide localmente contra o documento recusaria uma senha com quebra de linha
que o servidor aceitaria.

A direção do desvio é a inofensiva (o cliente recusa o que o servidor aceitaria,
nunca o contrário), e o caso é raro o bastante para não justificar contorção. Fica
registrado porque é o tipo de divergência que, descoberta em produção, consome uma
tarde.

### 4.5 — `IIdGenerator` separado de `ITokenGenerator` (emenda à decisão 21)

A decisão 21 escreveu um contrato único:

```ts
export interface ITokenGenerator {
  opaque(bytes?: number): string
  uuid(): string
}
```

**Emendado para:** `IIdGenerator { generate(): string }` em
`shared/providers/id-generator.ts`. O `ITokenGenerator { opaque() }` nasce na
fatia de refresh token.

O motivo não é só YAGNI. Id de entidade e segredo criptográfico têm **perfis de
segurança e motivos de mudar diferentes**: trocar o id de v4 para v7 não tem
relação nenhuma com a entropia de um refresh token. Juntos, o use case que só quer
um id recebe uma porta que também cunha segredos.

### 4.6 — `IHashProvider` só com `hash()` (emenda à decisão 21)

Register não compara senha; quem compara é o login. `compare()` chega na fatia de
login — uma linha na interface.

O custo de antecipar seria pior que a churn: um método a mais aqui significa um
adapter argon2 e um fake com código que nenhum teste exercita de verdade, num
boilerplate que N apps copiam.

### 4.7 — `@node-rs/argon2`, pinado em `2.1.0`

**Não** o pacote `argon2`. Bindings Rust pré-compilados: **sem node-gyp nem
toolchain C++ no Docker e no CI** — e imagem de produção é o próximo item do
roteiro do projeto.

Pin exato pelo mesmo critério da decisão 07: a lib tem `argon2id` como algoritmo
default, e o pin congela esse default. Ele não muda sem um bump que nós
controlamos. (`1.0.4` está deprecated; `2.1.0` é a latest em 2026-08-26.)

Os parâmetros de custo (memória/tempo/paralelismo) ficam nos defaults da lib nesta
fatia. Ajustá-los ao hardware alvo é trabalho de hardening, e vira decisão quando
houver alvo.

### 4.8 — Insert e trata a violação; nunca check-then-insert

O índice único funcional `users_email_lower_unique` é a autoridade sobre
unicidade. O repositório insere e traduz a violação para `EmailAlreadyInUseError`.

`findByEmail` antes do insert **corre**: duas requisições simultâneas com o mesmo
e-mail passam as duas pela checagem.

A tradução anda a **cadeia de `cause`**, não o erro de topo. Isso é o que a fatia
1 descobriu na prática: o Drizzle embrulha o erro do driver em `DrizzleQueryError`,
cuja `.message` **não** é o texto da query — é o texto da query mais todo
parâmetro vinculado (`params`), o que inclui o hash de senha quando o INSERT
falha; por isso o log passa por um serializer dedicado
(`src/infra/observability/error-serializer.ts`) antes de sair. O erro do
Postgres, com `.code` e `.constraint`, vive no `.cause`.

#### A checagem casa o nome da constraint, não só o código

Casar apenas `code === '23505'` é o que o byteflow faz, e é um bug latente: a
tabela `users` **já tem uma segunda constraint única**, a primary key. Uma colisão
de `id` levanta `23505` com `constraint = 'users_pkey'` e seria reportada ao
cliente como "e-mail já em uso" — um `409` mentiroso sobre uma falha que é `500`.

O repositório casa `code === '23505' && constraint === USERS_EMAIL_LOWER_UNIQUE_INDEX`.
Qualquer outra violação de unicidade continua borbulhando.

**Consequência sobre o `CLAUDE.md`.** O nome do índice passa a aparecer em dois
arquivos, e a exceção de magic strings dos arquivos de schema deixa de valer para
ele — pela própria razão que ela enuncia:

> *"Extracting them would add indirection over a name that appears exactly once."*

Não aparece mais uma vez só. Então o schema **exporta** a constante e a usa na
própria declaração:

```ts
// src/modules/auth/infra/drizzle/schema/users.ts
export const USERS_EMAIL_LOWER_UNIQUE_INDEX = 'users_email_lower_unique'
```

O valor não muda, então `db:generate` não deve produzir migration nenhuma — isso
precisa ser **confirmado**, não presumido, durante a implementação.

O teste de integração `users-schema.spec.ts` continua com o literal escrito à mão,
e isso não é incoerência: lá a duplicação é deliberada, para que a asserção não
seja tautológica. Um teste que importa o nome que está testando passa mesmo depois
de uma renomeação que quebra todo cliente.

### 4.9 — O container é montado dentro do `buildApp` (emenda à decisão 23)

A decisão 23 escreve o exemplo em `main/http.ts`. Isso é **anterior ao commit
`748c41a`**, que extraiu o `buildApp` justamente para o teste compor a aplicação
real.

Se o container nascer no `http.ts`, o `buildApp` que os testes chamam fica sem as
rotas do módulo — e volta exatamente o problema que aquele refactor resolveu:
algo registrado em produção e ausente nos testes.

`makeContainer(db)` mora em `src/main/container.ts`; `buildApp` chama.

A **substância** da decisão 23 fica intacta: o grafo é montado sem Fastify, e o
plugin recebe só a fatia dele. Só o endereço do composition root mudou.

### 4.10 — Migration nova, não regeneração

`email_verified_at` entra por `ALTER TABLE` numa segunda migration. A primeira já
está aplicada em CI, e a R4 é forward-only.

## 5. Fluxo ponta a ponta

```
POST /auth/register   { email, password }
 │
 ├─① Zod bodySchema          modules/auth/infra/http/endpoints/register.ts
 │     e-mail: trim, ≤254, formato
 │     senha:  8..128 + PASSWORD_POLICY_PATTERN
 │     ✗ → 400 VALIDATION_ERROR + details[]      (antes de gastar argon2)
 │
 ├─② container.auth.registerUser.execute({ email, password })
 │
 │   ┌── RegisterUserUseCase ───────────────────────── CAMADA PURA
 │   │   Email.create(raw)          normaliza: trim + lowercase
 │   │   Password.create(raw)       mesma política, sem trim
 │   │   hashProvider.hash(...)     argon2id  ~100ms
 │   │   idGenerator.generate()     uuid v4                     ← R7
 │   │   clock.now()                Date                        ← R7
 │   │   User.create({ id, email, passwordHash, now })
 │   │   usersRepository.save(user)
 │   │   return { id: user.id }
 │   └──────────────────────────────────────────────────────────
 │
 │   ┌── DrizzleUsersRepository ────────────────────── INFRA
 │   │   toPersistenceUser(user) → row
 │   │   insert
 │   │   catch 23505 (andando a cadeia de cause) → EmailAlreadyInUseError
 │   └──────────────────────────────────────────────────────────
 │
 ├─③ 201 { id }
 └─✗ EmailAlreadyInUseError → ConflictError → 409 EMAIL_ALREADY_IN_USE
```

**A ordem é deliberada.** Zod antes do use case, e o hash antes do insert:

- Payload inválido **nunca** paga os ~100ms do argon2.
- E-mail duplicado **paga** — é o custo de não fazer check-then-insert. Ver §14.

## 6. A árvore

```
src/
├── shared/providers/
│   ├── clock.ts                          IClock                    decisão 21
│   └── id-generator.ts                   IIdGenerator              emenda 4.5
├── infra/
│   ├── providers/system-clock.ts
│   ├── providers/uuid-id-generator.ts
│   └── observability/redact-paths.ts     + passwordHash            correção
│
├── modules/auth/
│   ├── value-objects/  email.ts · password.ts        (+ .spec)
│   ├── entities/       user.ts                       (+ .spec)
│   ├── errors/         invalid-email-error.ts
│   │                   invalid-password-error.ts
│   │                   email-already-in-use-error.ts
│   ├── repositories/   users-repository.ts           IUsersRepository
│   ├── providers/      hash-provider.ts              IHashProvider
│   ├── use-cases/      register-user.ts              (+ .spec)
│   ├── container.ts                                  makeAuthContainer
│   └── infra/
│       ├── drizzle/    schema/users.ts  (+ emailVerifiedAt)
│       │               user-mapper.ts
│       │               drizzle-users-repository.ts
│       ├── in-memory/  in-memory-users-repository.ts
│       ├── providers/  argon2-hash-provider.ts
│       └── http/       endpoints/register.ts · routes.ts
│
└── main/  container.ts  (novo) · app.ts  (modificado)

drizzle/<timestamp>_add_email_verified_at_to_users/
tests/integration/  drizzle-users-repository.spec.ts · register.spec.ts
```

**Um arquivo por erro**, seguindo o mesmo raciocínio de `schema/users.ts`: quando
o login trouxer `InvalidCredentialsError`, `EmailNotVerifiedError` e os três da
rotação de refresh, um arquivo único vira saco de gatos. O nome do arquivo é a
resposta para "que erros este módulo lança?".

## 7. Contratos

```ts
// src/shared/providers/clock.ts                                        PURO
export interface IClock {
  now(): Date
}

// src/shared/providers/id-generator.ts                                 PURO
export interface IIdGenerator {
  /** Identificador opaco de entidade. O formato é detalhe do adapter. */
  generate(): string
}

// src/modules/auth/providers/hash-provider.ts                          PURO
export interface IHashProvider {
  /** O resultado codifica os próprios parâmetros e o salt. */
  hash(plain: string): Promise<string>
}

// src/modules/auth/repositories/users-repository.ts                    PURO
export interface IUsersRepository {
  /**
   * Persiste um usuário novo. Lança `EmailAlreadyInUseError` quando o e-mail já
   * existe — a autoridade é o índice único do banco, não uma consulta prévia.
   */
  save(user: User): Promise<void>
}
```

Implementações:

```ts
// src/infra/providers/system-clock.ts                                  INFRA
export class SystemClock implements IClock {
  now(): Date {
    return new Date()
  }
}

// src/infra/providers/uuid-id-generator.ts                             INFRA
export class UuidIdGenerator implements IIdGenerator {
  generate(): string {
    return randomUUID()
  }
}
```

> **Sobre o UUID v4.** O `crypto.randomUUID({ version: 7 })` do Node 24 **ignora a
> opção em silêncio** e devolve v4 — verificado na fatia 1, nas versões `24.16.0`
> e `24.19.0`. O Postgres 18.4 tem `uuidv7()` nativo, mas ele está do lado que a
> R7 quer evitar. Migrar para v7 depois é trocar este arquivo e emitir uma
> migration que altera o default da coluna — que é exatamente o que o contrato
> comprou (§4.5).

## 8. Value objects

```ts
// src/modules/auth/value-objects/email.ts                              PURO

/** Limite superior da RFC 5321. A coluna é `text`, então o guard real é este. */
const MAX_EMAIL_LENGTH = 254

export class Email {
  private constructor(readonly value: string) {
    // `readonly` é só compile-time. O freeze impede que um Email entregue por
    // `user.email` seja corrompido em runtime.
    Object.freeze(this)
  }

  /**
   * Constrói a partir de entrada não confiável, normalizando para minúsculas.
   * A normalização é o que faz o valor gravado sempre casar com o índice
   * funcional `lower(email)` — toda consulta deve usar `lower(email) = $1`.
   *
   * A validação é deliberadamente pragmática: regex completa da RFC 5322 é
   * notoriamente errada, e entregabilidade real se prova por verificação de
   * e-mail, não por sintaxe.
   */
  static create(raw: string): Email { /* lança InvalidEmailError */ }

  /**
   * Reidrata valor já persistido, e portanto já validado. Pula a validação de
   * propósito: revalidar na leitura faria uma regra futura mais estrita quebrar
   * o carregamento de linhas que eram válidas quando escritas.
   */
  static fromTrusted(value: string): Email {
    return new Email(value)
  }

  equals(other: Email): boolean {
    return this.value === other.value
  }
}
```

Regras que `create` aplica, nesta ordem: `trim().toLowerCase()`; não vazio; no
máximo `MAX_EMAIL_LENGTH`; sem espaço interno (o `trim` só tira das pontas);
exatamente um `@`, com parte local e domínio não vazios.

```ts
// src/modules/auth/value-objects/password.ts                           PURO

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 128

/**
 * Letra + dígito + não-alfanumérico, em qualquer ordem.
 *
 * Um padrão só, e não três `.regex()`: verificado que três produzem
 * `INVALID_FORMAT` para as três regras e ainda duplicam entradas no `details`
 * quando mais de uma falha (§13). Flag `s` para que uma senha com quebra de
 * linha não escape dos lookaheads.
 */
export const PASSWORD_POLICY_PATTERN = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[^a-zA-Z0-9])/s

/**
 * Guarda a política de senha, segurando o texto puro apenas em trânsito até a
 * camada de aplicação hashear.
 *
 * O texto puro vive num campo `#`, que é não-enumerável: `JSON.stringify(pw)` é
 * `{}` e a senha não vaza por log nem por serialização.
 *
 * Deliberadamente **não** faz trim: espaço no começo ou no fim é caractere
 * válido de senha, ao contrário do e-mail.
 *
 * Hashear não é trabalho deste VO — é capacidade técnica, e mora atrás do
 * `IHashProvider`. O VO é dono da política, e só.
 */
export class Password {
  readonly #value: string
  private constructor(value: string) { /* ... */ Object.freeze(this) }
  static create(raw: string): Password { /* lança InvalidPasswordError */ }
  get value(): string { return this.#value }
}
```

## 9. A entidade

```ts
// src/modules/auth/entities/user.ts                                    PURO

export interface CreateUserProps {
  id: string
  email: Email
  passwordHash: string
  /** Fornecido pelo `IClock`, nunca por `new Date()` — R7. */
  now: Date
}

/**
 * Credenciais de um usuário. Estado em campos privados `#`, que são realmente
 * privados e não-enumeráveis em runtime: `JSON.stringify(user)` devolve `{}`,
 * então o hash de senha não escapa por serialização acidental num log ou num
 * `reply.send(user)`.
 *
 * A entidade não conhece o formato da row — quem converte é
 * `infra/drizzle/user-mapper.ts` (decisão 20).
 */
export class User {
  readonly #id: string
  readonly #email: Email
  readonly #passwordHash: string
  readonly #emailVerifiedAt: Date | null
  readonly #createdAt: Date
  readonly #updatedAt: Date

  /**
   * Nasce **não verificada** (`emailVerifiedAt: null`). Nada consome esse estado
   * até a fatia de verificação de e-mail; ver §14.
   *
   * O domínio é dono do id e dos timestamps, então a linha está completa antes
   * do insert e os defaults do schema (`defaultRandom` / `defaultNow`) são
   * apenas defense-in-depth para escrita direta — seed, psql, migration de dados.
   */
  static create(props: CreateUserProps): User

  get id(): string
  get email(): Email
  get passwordHash(): string
  get emailVerifiedAt(): Date | null
  get createdAt(): Date
  get updatedAt(): Date
}
```

**Não existe `restore()` nesta fatia.** Ver §11.

## 10. Erros

Três erros novos, um arquivo cada, em `src/modules/auth/errors/`:

| Erro | Categoria (`shared/errors/app-error.ts`) | HTTP | `code` |
|---|---|---|---|
| `InvalidEmailError` | `ValidationError` | 400 | `INVALID_EMAIL` |
| `InvalidPasswordError` | `ValidationError` | 400 | `INVALID_PASSWORD` |
| `EmailAlreadyInUseError` | `ConflictError` | 409 | `EMAIL_ALREADY_IN_USE` |

Nenhum deles conhece HTTP — o `error-handler.ts` continua sendo o único lugar do
sistema que traduz para status. O mapa não cresce: os três caem em duas das seis
categorias que já existem.

Pela §4.2, os dois primeiros são **inalcançáveis por HTTP** (o Zod recusa antes).
Eles existem para os outros entrypoints da decisão 10 — worker, cron, seed.

## 11. Repositório e mapper

```ts
// src/modules/auth/infra/drizzle/user-mapper.ts                        INFRA

type NewUserRow = typeof users.$inferInsert

export const toPersistenceUser = (user: User): NewUserRow => ({
  id: user.id,
  email: user.email.value,        // desembrulha o VO — infra, não o domínio
  passwordHash: user.passwordHash,
  emailVerifiedAt: user.emailVerifiedAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
})
```

```ts
// src/modules/auth/infra/drizzle/drizzle-users-repository.ts           INFRA

/** `unique_violation` do Postgres. */
const PG_UNIQUE_VIOLATION = '23505'

/** O recorte do erro do `pg` que interessa aqui. */
interface UniqueViolationCandidate {
  code?: unknown
  constraint?: unknown
}

/**
 * Anda a cadeia de `cause`: o Drizzle embrulha o erro do driver em
 * `DrizzleQueryError`, cuja `.message` NÃO é só o texto da query — é o texto
 * mais todo parâmetro vinculado, o que inclui o hash de senha (por isso o log
 * passa pelo serializer dedicado antes de sair). O erro do `pg`, que carrega
 * `.code` e `.constraint`, vive no `.cause`. Descoberto na fatia 1.
 *
 * Casa o **nome da constraint**, não só o código. A tabela já tem uma segunda
 * constraint única — a primary key —, então um `23505` de `users_pkey` viraria
 * um `409` "e-mail já em uso" sobre uma falha que é `500`. Qualquer violação
 * que não seja a do índice de e-mail continua borbulhando.
 */
function isEmailAlreadyInUse(error: unknown): boolean {
  let current: unknown = error

  while (typeof current === 'object' && current !== null) {
    const candidate = current as UniqueViolationCandidate

    if (
      candidate.code === PG_UNIQUE_VIOLATION &&
      candidate.constraint === USERS_EMAIL_LOWER_UNIQUE_INDEX
    ) {
      return true
    }

    current = 'cause' in current ? current.cause : undefined
  }

  return false
}

export class DrizzleUsersRepository implements IUsersRepository {
  constructor(private readonly db: Database) {}

  async save(user: User): Promise<void> {
    try {
      await this.db.insert(users).values(toPersistenceUser(user))
    } catch (error) {
      if (isEmailAlreadyInUse(error)) throw new EmailAlreadyInUseError()
      throw error
    }
  }
}
```

O `InMemoryUsersRepository` **precisa replicar a unicidade case-insensitive** e
lançar o mesmo `EmailAlreadyInUseError`. Se ele divergir do Drizzle, o teste
unitário do use case mente.

Como o `Email.create` já normaliza para minúsculas, comparar `email.value` é
suficiente — a in-memory não precisa reimplementar `lower()`.

### Os quatro rulings de YAGNI, e o que eles fazem parecer

| Peça | Só isto | Por quê |
|---|---|---|
| `IHashProvider` | `hash()` | `compare()` é do login |
| `IUsersRepository` | `save()` | `findByEmail()` é do login |
| `user-mapper.ts` | `toPersistenceUser()` | nada **lê** usuário ainda |
| `User` | `create()` | sem leitura, não há o que reidratar |

O terceiro é o que mais chama atenção em review: **o mapper tem uma direção só.**
É consequência direta do segundo. Sem `findByEmail`, o `toDomainUser` não teria
consumidor, e código sem consumidor num boilerplate é código que N apps copiam sem
nunca testar.

`toDomainUser` e `User.restore()` chegam na fatia de login, exercitados pelo
`findByEmail`.

## 12. HTTP e composição

```ts
// src/modules/auth/infra/http/endpoints/register.ts                    INFRA

const bodySchema = z.object({
  email: z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email()),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .regex(PASSWORD_POLICY_PATTERN),
})

const createdSchema = z.object({ id: z.uuid() })
```

As constantes vêm dos value objects — uma definição só para os números (§4.2).

A rota declara também `400` e `409` como `errorResponseSchema`, para que o OpenAPI
publique o contrato de erro. O `errorResponseSchema` tem `details` opcional, então
os dois corpos que o `error-handler.ts` produz passam pela serialização.

```ts
// src/modules/auth/infra/http/routes.ts                                INFRA
export const authRoutes: FastifyPluginAsync<{ container: AuthContainer }> =
  async (app, { container }) => {
    await app.register(registerRoute, { container })
  }
```

```ts
// src/modules/auth/container.ts                                  COMPOSITION
export function makeAuthContainer(db: Database) {
  const usersRepository = new DrizzleUsersRepository(db)
  const hashProvider = new Argon2HashProvider()
  const clock = new SystemClock()
  const idGenerator = new UuidIdGenerator()

  return {
    registerUser: new RegisterUserUseCase(
      usersRepository, hashProvider, clock, idGenerator,
    ),
  }
}
export type AuthContainer = ReturnType<typeof makeAuthContainer>

// src/main/container.ts                                          COMPOSITION
export function makeContainer(db: Database) {
  return { auth: makeAuthContainer(db) }
}
export type Container = ReturnType<typeof makeContainer>
```

`makeContainer(db)` e não `makeContainer(db, env)`: nenhuma variável de ambiente
nova entra nesta fatia. Ver §14.

```ts
// src/main/app.ts                                                  MODIFICADO
const AUTH_PREFIX = '/auth'

const container = makeContainer(db)
await app.register(authRoutes, { prefix: AUTH_PREFIX, container: container.auth })
```

O plugin recebe **só `container.auth`** — decisão 23. Acesso a outro módulo vira
erro de compilação, sem depender de lint.

O prefixo mora no `main/`, e não no módulo: onde a rota é montada é decisão do
composition root. O endpoint declara `/register`; o caminho final é
`POST /auth/register`.

## 13. Achados empíricos

Verificado antes de escrever esta spec, não presumido.

### Três `.regex()` produzem códigos indistinguíveis e duplicados

Sonda: `buildServer` real, rota com o schema, `app.inject`.

| Entrada | `details` retornado |
|---|---|
| `"abcdefghij"` (sem dígito e sem especial) | `[{password, INVALID_FORMAT}, {password, INVALID_FORMAT}]` |
| `"abcdefgh1"` (sem especial) | `[{password, INVALID_FORMAT}]` |
| `"12345678!"` (sem letra) | `[{password, INVALID_FORMAT}]` |
| `"aB1!"` (curta) | `[{password, TOO_SMALL}]` |
| e-mail `"nope"` | `[{email, INVALID_FORMAT}]` |

Duas entradas idênticas no primeiro caso. Foi o que motivou §4.4.

### A flag `s` muda o resultado, e o OpenAPI a descarta

| Senha | com `/s` | sem `/s` |
|---|---|---|
| `"abcd1234!"` | aceita | aceita |
| `"abc\n123!"` (quebra no meio) | aceita | **recusa** |
| `"\nabc123!x"` (quebra no início) | aceita | **recusa** |
| `"\n1234567"` (sem letra) | recusa | recusa |

O Zod honra a flag: `"\nabc123!x"` passa por `z.string().regex(WITH_S)`.

O documento OpenAPI gerado, não — sai como
`"pattern": "^(?=.*[a-zA-Z])(?=.*\\d)(?=.*[^a-zA-Z0-9])"`, sem flag, sem erro e
sem aviso, porque `pattern` do JSON Schema não tem esse conceito. Motivou o bloco
final do §4.4.

### `REDACT_PATHS` não cobre `passwordHash`

O redact do pino casa nome de chave exato: `password` não pega `passwordHash`.
Motivou a correção do §4.1.

### `@node-rs/argon2`

`2.1.0` é a latest em 2026-08-26; `1.0.4` está deprecated.

## 14. Custos aceitos

Escritos aqui para não virarem descoberta em incidente.

- **Enumeração de e-mail.** O `409` informa que a conta existe. Sem provedor de
  e-mail não há alternativa honesta — a saída clássica (responder `201` sempre e
  avisar por e-mail) exige o provedor que ainda não foi decidido. A mitigação real
  é rate limit, que é decisão em aberto no `DECISIONS.md` §6.
- **Amplificação de CPU no duplicado.** Registrar um e-mail existente custa um
  argon2 completo, porque o hash precede o insert e não há check prévio (que
  correria). Mesma mitigação: rate limit. O lado bom é que o custo é **uniforme**
  entre e-mail novo e existente, o que não abre oráculo de timing.
- **`email_verified_at` nasce e fica sempre `null`.** É assento reservado. Ganho:
  a entidade e o mapper já têm a forma final, e nem `User` nem `user-mapper.ts`
  mudam quando a verificação chegar. Custo: uma coluna que nada lê até lá.
- **Decisão 14 continua sem execução.** O módulo `auth` não tem `config.ts` — o
  argon2 usa os defaults da lib e nenhuma variável de ambiente nova aparece.
  A decisão 14 estreia com o `JWT_SECRET` do login.
- **Decisão 22 continua sem execução.** Uma tabela, um repositório, sem transação
  — que é exatamente o que a própria decisão 22 manda: *"o UoW é para quem precisa
  dele"*.

## 15. Testes

### Unitários — colocados, sem I/O

Portas de um método (`IClock`, `IIdGenerator`, `IHashProvider`) viram **objeto
literal dentro do `.spec.ts`**. Não merecem arquivo, e `tsconfig.build.json` só
exclui `*.spec.ts` — um arquivo de fake iria para o `dist/`. Só o
`InMemoryUsersRepository` ganha arquivo, porque tem comportamento real e a decisão
09 o exige.

- **`email.spec.ts`** — normaliza (trim + lowercase); rejeita vazio, `>254`,
  espaço interno, zero `@`, dois `@`, parte local vazia, domínio vazio;
  `fromTrusted` não valida.
- **`password.spec.ts`** — cada regra da política isolada; aceita senha válida;
  **não faz trim**; `JSON.stringify` de uma `Password` é `{}`.
- **`user.spec.ts`** — usa o `id` e o `now` recebidos, sem gerar nada;
  `createdAt === updatedAt` no nascimento; `emailVerifiedAt` é `null`;
  `JSON.stringify(user)` é `{}`.
- **`register-user.spec.ts`** — persiste o usuário; normaliza o e-mail antes de
  salvar (`"  JOAO@Example.COM "` → `"joao@example.com"`); hasheia o texto puro;
  o `id` vem do `IIdGenerator` e os timestamps do `IClock`; propaga o
  `EmailAlreadyInUseError` do repositório.

### Integração — Postgres real

- **`drizzle-users-repository.spec.ts`** — a row gravada bate campo a campo com a
  entidade; um segundo `save` com e-mail que difere só em maiúsculas lança
  `EmailAlreadyInUseError`; e **um `save` com `id` repetido e e-mail diferente
  NÃO lança `EmailAlreadyInUseError`** — viola `users_pkey`, também com código
  `23505`, e tem que borbulhar. Essa terceira é o que separa "casa o código" de
  "casa a constraint" (§4.8); sem ela, a versão errada passa nos outros dois.
- **`register.spec.ts`** — via `buildApp`, a mesma função que o `main/http.ts`
  chama: `201 { id }`; `409` com `code: EMAIL_ALREADY_IN_USE` no duplicado; `400`
  com `details` no payload inválido; e **nem a senha nem o hash aparecem no corpo
  ou no stream de log**.

A última asserção é regressão direta do buraco do `REDACT_PATHS` (§13).

### Deleta

O teste marcado `SCAFFOLDING` em `tests/integration/users-schema.spec.ts`. O
comentário dele já mandava, e o substituto é exatamente o
`drizzle-users-repository.spec.ts`.

## 16. Emendas de documentação

**Versionado — `ARCHITECTURE.md`:** a árvore do §2 ganha o módulo real; o §13
("o que ainda não existe") perde as linhas que esta fatia passa a cobrir.

**Versionado — `CLAUDE.md`:** a exceção de magic strings para arquivos de schema
ganha o limite que o §4.8 revelou. O texto atual justifica escrever o nome inline
porque *"appears exactly once"*; quando um nome passa a ser **lido** de outro
arquivo — como `USERS_EMAIL_LOWER_UNIQUE_INDEX`, que o repositório precisa para
distinguir a violação —, a justificativa cai e ele vira constante exportada,
declarada e usada no próprio schema.

**Local — `docs/DECISIONS.md`** (gitignored, não viaja com o repositório):

| Decisão | Emenda |
|---|---|
| 20 | confirmada; registrar o motivo dos campos `#` e o achado do `REDACT_PATHS` |
| 21 | `IIdGenerator` separado de `ITokenGenerator`; `IHashProvider` nasce só com `hash()` |
| 23 | container no `buildApp`, não no `main/http.ts` — substância intacta, endereço mudou |

## 17. Próximas fatias

1. **Verificação de e-mail** — `email_verifications`, `IMailer` (provedor a
   decidir), `POST /auth/verify-email/request` e `POST /auth/verify-email`.
   Estreia a decisão 22 (Unit of Work) e o `ITokenGenerator.opaque()`.
2. **Login** — decisão 11 inteira. É quem dá dente à verificação, recusando
   `email_verified_at IS NULL`. Estreia a decisão 14 (`config.ts` do módulo com
   `JWT_SECRET`) e a decisão 12 (cookie `httpOnly` no refresh).

Itens do roteiro do projeto que seguem abertos e são independentes desta fatia:
lint de fronteira (`dependency-cruiser`, decisão 18) e imagem Docker de produção.

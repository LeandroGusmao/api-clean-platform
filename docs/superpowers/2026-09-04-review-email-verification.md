# Revisão final de branch — `feat/email-verification` (5a34627..2bfd4dc, 18 commits)

Revisor: sessão de revisão de branch inteira, 2026-09-04.
Fontes lidas: spec de desenho (§1–§14), plano, diff completo (11.038 linhas), ledger
de execução, mais o estado final dos arquivos de produção do módulo `auth`.
Suítes **não** foram executadas (já verdes: lint, typecheck, 322 unit, 131 integration, build).

**Veredito: NÃO mergear como está.** Uma falha Crítica e três Importantes.
A fatia é, no geral, de qualidade alta — a disciplina do §8 do Unit of Work virou
estrutura de verdade (o thunk), a taxonomia de erro está certa, o `Pick` tem dente,
a busca é sempre por `user_id`, o `consume` condicional é à prova de corrida, e as
revisões por tarefa claramente pegaram o que dava para pegar tarefa a tarefa.
O que sobra é exatamente o que só aparece olhando o fluxo inteiro.

Contagem: **1 Crítica · 3 Importantes · 7 Menores.**

---

## CRÍTICA

### C1 — Sequestro de conta antes da verificação: o caminho de colisão do `register` não reescreve a senha

**Arquivos:** `src/modules/auth/use-cases/register-user.ts:129-169` (o método
`#deliverForExistingAccount`), em conjunto com
`src/modules/auth/use-cases/confirm-email.ts:98-121` e
`src/modules/auth/use-cases/login-user.ts:68`.

**O que o código faz.** No ramo "conta existe e **não** está verificada", o use case
lê o usuário, checa o cooldown e emite um código novo:

```ts
const active = await this.emailVerifications.findActiveByUserId(existing.id)
if (active !== null && now.getTime() - active.createdAt.getTime() < this.resendCooldownMs) {
  return NO_DELIVERY
}
return this.uow((repos) => this.issuer.issueFor(existing, repos.emailVerifications, now))
```

`passwordHash` foi calculado na linha 84 e é **descartado**. A senha da conta continua
sendo a da primeira requisição de cadastro que criou a linha.

**A falha concreta, ponta a ponta.**

1. O atacante chama `POST /auth/register { email: vitima@x.com, password: P_atacante }`.
   Recebe `202`. A conta nasce **não verificada**, com o hash de `P_atacante`.
   O gate do login (`login-user.ts:68`) impede o atacante de entrar — por enquanto.
2. A vítima, mais tarde, se cadastra de verdade: `{ vitima@x.com, P_vitima }`.
   `users.save` levanta `23505`, cai no `catch`, e o §6.1 manda "recadastrar é
   reenviar": a vítima recebe um e-mail **idêntico** ao de um cadastro novo, com um
   código de seis dígitos. Nada na resposta `202` nem no e-mail diz que a conta já
   existia, e a senha que ela acabou de escolher foi jogada fora em silêncio.
3. A vítima digita o código. `ConfirmEmailUseCase` marca `email_verified_at`,
   emite sessão e faz auto-login. Ela está dentro, e nada parece errado.
4. A conta agora está **verificada**. O gate do login passa. O atacante entra com
   `P_atacante`, quando quiser, para sempre.

**Por que isto é pior do que era antes desta fatia.** No `main`, o `register`
respondia `409 EMAIL_ALREADY_IN_USE`: a vítima aprendia que a conta existia e não
prosseguia. E não havia estado "verificado" para o atacante herdar. São exatamente
as duas mudanças desta fatia — o `202` que esconde a colisão e o `verified` que o
`confirm` concede — que compõem o ataque. Isto é o padrão clássico de
*pre-hijacking* por conta não verificada.

**E a vítima não tem saída.** `POST /auth/password` exige `currentPassword`, que ela
não conhece. Recuperação de senha é a fatia seguinte, ainda não existe. A vítima fica
com uma conta verificada cuja senha é de outra pessoa, e sem nenhum caminho para
retomá-la.

**Cobertura de teste:** nenhuma. `register-user.spec.ts:315` ("emails a fresh code
when the address has an UNVERIFIED account") e `:339` afirmam sobre o e-mail e sobre
o call log; nenhum teste, unitário ou de integração, olha o `password_hash` depois
do caminho de colisão. É por isso que doze revisões limpas não o pegaram: nenhuma
tarefa isolada tinha as três peças em vista ao mesmo tempo.

**Menor correção possível** — três linhas, dentro do `uow` que o ramo já abre:

```ts
return this.uow(async (repos) => {
  // Quem prova controle do endereço fica com a senha que ELE escolheu. Sem isto,
  // a primeira tentativa de cadastro fixa a senha e a verificação a legitima.
  await repos.users.updatePasswordHash(existing.id, passwordHash, now)
  return this.issuer.issueFor(existing, repos.emailVerifications, now)
})
```

`passwordHash` passa como parâmetro do método privado. A escrita é `repos.users`,
dentro da transação — o `Pick<IUsersRepository, 'findByEmail'>` do construtor
continua intacto e a §9 continua satisfeita. Sobrescrever a senha de uma conta
**não verificada** não perde nada: ninguém provou ser dono dela, e o gate do login
já impede que ela seja usada. O ramo `emailVerifiedAt !== null` retorna antes, então
conta verificada nunca é tocada.

Isto precisa de um teste explícito (`register-user.spec.ts`: recadastro em conta não
verificada troca o hash armazenado) e de uma linha no §6.1 da spec, que hoje descreve
o ramo só em termos de qual e-mail sai.

---

## IMPORTANTES

### I1 — A afirmação anti-enumeração é falsa por **latência** no `resend`, e o código afirma o contrário por escrito

**Arquivos:** `src/modules/auth/use-cases/request-email-verification.ts:50-52` e
`:66-72`; `src/modules/auth/infra/http/endpoints/resend-verification.ts:18-24`;
`src/modules/auth/use-cases/register-user.ts:24-31`.

O comentário em `request-email-verification.ts:51` diz, sem qualificação:

> *"Unknown address, or already verified: nothing truthful to send, and the response
> must not say which. **Silence here costs the same as a send.**"*

E a descrição publicada do endpoint (`resend-verification.ts:22-23`) diz que
"**um status ou um atraso** que distinguisse os casos transformaria este endpoint no
oráculo de contas". As duas afirmações são falsas contra o código:

| Caso | Trabalho feito antes de responder `202` |
|---|---|
| endereço desconhecido | 1 `SELECT` indexado |
| conta já verificada | 1 `SELECT` indexado |
| não verificada, dentro do cooldown | 2 `SELECT` |
| não verificada, fora do cooldown | 2 `SELECT` + transação com 2 escritas + **um round-trip SMTP completo** |

O último ramo custa a ida ao relay — dezenas de milissegundos contra frações de
milissegundo. Não é ruído estatístico: é uma operação de rede inteira presente num
ramo e ausente nos outros. Um chamador anônimo distingue "este endereço tem conta
não verificada sem código recente" de todo o resto com uma requisição.

`NO_DELIVERY = async () => {}` em `register-user.ts:31` carrega o mesmo comentário
("silence must cost the same as sending") e a mesma falsidade — ali o argon2
domina os dois ramos, mas o argon2 é **aditivo**, não sobreposto ao SMTP: o ramo que
manda e-mail continua custando um round-trip a mais.

O §11.2 da spec registra o timing do `register` como *[suposto]* e não medido. Isso
é honesto. Mas nem o §11 nem o §12 cobrem o `resend`, e o `resend` é justamente o
endpoint cuja razão de existir é a paridade de resposta.

**Menor correção.** A paridade real exige tirar o envio do caminho da requisição —
o outbox que o §5.3 adiou. Enquanto isso, o mínimo honesto é: (a) reescrever os dois
comentários para dizer o que o código faz ("a resposta não distingue os casos;
a **latência** distingue, e o conserto é o outbox do §5.3"); (b) registrar isto como
custo aceito no §12, ao lado do §12.7. Não deixar uma afirmação de segurança falsa
em comentário na camada pura — é assim que o próximo mantenedor raciocina errado.

### I2 — O `resend` propaga falha de envio, e isso é um oráculo binário de contas; a spec só registrou o caso do `register`

**Arquivos:** `src/modules/auth/use-cases/request-email-verification.ts:72`;
`src/modules/auth/container.ts:109-115` (o issuer recebe o `emailSender` **cru**,
não o `BestEffortEmailSender`).

O §12.7 da spec, e o ruling correspondente no ledger, analisam exatamente este modo
de falha — e só para o `register`:

> *"contra um relay que recusa deterministicamente um destinatário, um endereço livre
> responde `500` e um endereço com código não expirado recente responde `202`."*

O `resend` tem a forma idêntica e mais limpa, porque não cria nada:

- SMTP fora do ar (ou destinatário recusado): `resend(x)` responde **500** se `x`
  tem conta não verificada sem código recente, e **202** em todos os outros casos.

Ou seja: durante qualquer indisponibilidade de e-mail, o endpoint que existe para
responder `202` sempre passa a responder por status a pergunta "esta conta existe?".
Isso não está em lugar nenhum da documentação.

**Menor correção.** Estender o §12.7 para cobrir os dois endpoints explicitamente
(o texto atual diz "no `register`"), e o ruling do ledger junto. Não recomendo
inverter a decisão — `BestEffortEmailSender` aqui reabriria a falha que o §9.5
rejeitou (SMTP mal configurado respondendo `202` para sempre). O conserto real
continua sendo o outbox.

### I3 — `.env.example` não ganhou nenhuma das doze variáveis novas

**Arquivo:** `.env.example` (versionado; `git ls-files` confirma).

O arquivo documenta hoje toda outra manopla do projeto, inclusive os dois pares de
rate limit anteriores. Esta fatia adiciona **doze** variáveis e nenhuma aparece:

- `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_REQUIRE_TLS`, `MAIL_FROM`,
  `MAIL_USER`, `MAIL_PASSWORD`;
- `EMAIL_VERIFICATION_TTL_SECONDS`, `EMAIL_VERIFICATION_MAX_ATTEMPTS`,
  `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`;
- `REGISTER_RATE_LIMIT_*`, `EMAIL_VERIFY_RATE_LIMIT_*`, `EMAIL_VERIFY_RESEND_RATE_LIMIT_*`.

Consequência concreta: quem for subir esta branch em produção descobre
`MAIL_HOST` / `MAIL_PORT` / `MAIL_FROM` obrigatórios e `MAIL_REQUIRE_TLS=true` só
quando o processo morre no boot. Falha fechada e com mensagem clara — bom —, mas o
único arquivo que um operador lê **antes** de deployar não menciona nada disso.
A Tarefa 13 era, literalmente, "fazer a documentação bater com o código".

O §13 da spec (tabela de emendas de documentação) também não lista `.env.example`.
Isso é omissão da spec, propagada para a execução.

**Menor correção:** um bloco comentado no `.env.example`, no molde dos que já existem,
com os defaults de dev e a nota de que os três `MAIL_*` e o `MAIL_REQUIRE_TLS=true`
são obrigatórios em produção. Aproveitar para pôr ali a nota do Mailpit
(`http://127.0.0.1:8025`) que o ruling da T13 deu por sem casa — ver §"Rulings".

---

## MENORES

### m1 — `VERIFICATION_CODE_PATTERN` duplica o número de dígitos como literal

`src/modules/auth/infra/http/endpoints/confirm-email.ts:29`:
`const VERIFICATION_CODE_PATTERN = /^[0-9]{6}$/`. O `6` canônico é
`VERIFICATION_CODE_DIGITS` em `services/email-verification-issuer.ts:11`. Trocar o
tamanho do código em um lugar faz o endpoint responder `400` a todo código válido
gerado no outro — falha silenciosa em revisão, ruidosa em produção. É também a regra
de "sem números mágicos" do `CLAUDE.md`, com o agravante de haver constante nomeada
a um import de distância (o mesmo arquivo já importa `MAX_EMAIL_LENGTH` do puro).
Correção: `new RegExp(\`^[0-9]{${VERIFICATION_CODE_DIGITS}}$\`)`.

### m2 — `docs/STRUCTURE.md` §4: `notifications/` não entrou na regra de fronteira

A fatia adiciona `notifications/` à árvore (linha ~45) e à tabela de naturezas
(linha 117), mas **não** ao glob que *define* `pure` na tabela da regra de fronteira
(linha 144):
`src/modules/*/{entities,value-objects,repositories,providers,use-cases,dtos,errors}/**`.
`services/` também falta ali, e isso é anterior a esta fatia. Sem
`dependency-cruiser` funcionando (TS 7), nada enforça — o documento é a regra, e ela
agora se contradiz internamente.

### m3 — `docs/STRUCTURE.md:117` diz que os contratos de e-mail moram em `providers/` do módulo

`| providers/ | puro | **Contratos** de serviço externo (hash, token, e-mail) |`.
A linha é anterior à branch, mas esta fatia acabou de decidir o contrário: o §7.1
põe `IEmailSender` em `shared/ports/`, e é lá que ele está. A frase agora aponta
para o lugar errado.

### m4 — Negação de verificação permanente sobre um endereço conhecido, não registrada

Qualquer anônimo que saiba um endereço pode gastar as cinco tentativas do código vivo
(`EMAIL_VERIFICATION_MAX_ATTEMPTS`) logo depois de cada emissão, e repetir a cada
cooldown. A vítima nunca consegue verificar, e — com o gate do login — nunca consegue
entrar. O §12.2 registra o custo de *invalidar* o código por reenvio; não registra
este, que é mais forte porque não precisa de reenvio e não deixa rastro na caixa da
vítima. Contido pelos tetos por IP, não eliminado. Recomendo registrar no §12; o
conserto de verdade (throttle por conta, não por IP) é fatia própria.

### m5 — `confirm` distingue os seis modos de falha por trabalho feito

`confirm-email.ts:61-87`: endereço desconhecido = 1 `SELECT`; endereço conhecido com
código utilizável e palpite errado = 2 `SELECT` + sha256 + 1 `UPDATE` autocommit.
Todos respondem `422` com o mesmo corpo. A diferença é sub-milissegundo e muito menos
explorável que I1 — mas é a mesma classe, e o §6.3 afirma "um erro só" como se isso
resolvesse o oráculo inteiro. Vale uma frase.

### m6 — Serviço `mailpit` do CI sem health check

`.github/workflows/ci.yml`: o serviço `postgres` traz `--health-cmd` e cinco
retentativas; o `mailpit` novo não traz nada. A suíte de integração faz
`waitForMessageCount` com 5s de teto, o que cobre a indexação da mensagem, mas não
cobre o container ainda não estar aceitando SMTP na 1025 no primeiro envio — aí quem
falha é o `sendMail` da aplicação, com `500` no `register`. Risco de flake em partida
fria. Correção: `options: --health-cmd "wget -q -O- http://localhost:8025/readyz"`
(ou equivalente que a imagem exponha).

### m7 — Detritos de teste, todos inertes

- `tests/integration/verify-email.spec.ts:79` passa
  `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: 0`, valor que o `.positive()` do
  schema recusaria. Legítimo (o objeto já vem parseado), mas é uma fixture fora do
  domínio válido da configuração, e o comentário acima dela não diz isso.
- `tests/integration/verify-email.spec.ts:44`: `WRONG_CODE = '000000'` colide com o
  código real uma vez em 10⁶ e aí o teste do teto de tentativas falha. Aceitável.
- `NUMERIC_CODE = '000000'` continua duplicado à mão em quatro spec files
  (`login-user`, `refresh-token`, `change-password`, `confirm-email`). **Este é o
  único minor do ledger que a T13 não fechou** — ver a triagem abaixo.
- `verification-email.ts`: os três *subjects* são constantes nomeadas e os três
  *corpos* são literais inline no mesmo arquivo. Inconsistência cosmética com a regra
  do `CLAUDE.md`; defensável (o corpo é o valor de retorno), mas então o subject
  também era.

---

## Conferência do que estava explicitamente sob suspeita

**Consistência entre os quatro endpoints que emitem sessão** — `login`, `refresh`,
`change-password`, `confirm-email`: todos respondem `200` com `sessionTokensSchema`;
os três sem sinal de entrada (`login`, `change-password`, `confirm-email`) aceitam
`refreshTransport`; `refresh` o infere do canal de chegada. `change-password` limpa o
cookie em modo body e os outros não — correto e não uma inconsistência: só ele revoga
todas as famílias. Docstring de `session-tokens.ts` corrigida para quatro. **Limpo.**

**503 nas rotas que abrem transação** — `register`, `confirm-email`, `resend`,
`refresh`, `logout`, `logout-all`, `change-password` declaram; `login` e `me` não
abrem transação e não declaram. **Limpo, e a única correção de meio de caminho
(commit 6242735) fechou o buraco certo.**

**Reuso de código consumido / código de outro usuário** — `findActiveByUserId` filtra
`consumed_at IS NULL` e a busca é sempre por `user_id`; `consume` é `UPDATE ... WHERE
id = ? AND consumed_at IS NULL` e devolve se **esta** chamada queimou, com o `throw`
**dentro** do callback para dar rollback. Sem índice único em `code_hash`, com o
motivo escrito no schema. **Limpo — é a melhor parte da fatia.**

**Retry de transação reenviando e-mail** — `23505` não está em `TRANSIENT_SQLSTATES`,
então não há reexecução; e mesmo que houvesse, o thunk garante que nada dentro do
callback envia. O teste de ordem por `toEqual` no call log mata deleção, reordenação
e envio-por-dentro de uma vez. **Limpo.**

**R6 / R7 / R1 / decisão 15 / decisão 12** — `process.env` só em `env.ts`;
`EmailVerification` usa `new Date(millis)` (determinístico) e nunca `new Date()`;
`matches` recebe digest, não código cru; repositórios só na API core do Drizzle
(o `sql` tag do incremento é core, e evita read-modify-write, corretamente);
nenhum use case recebe logger — a política best-effort virou decorador na fiação;
`refreshTransport` no `confirm`. **Limpos.**

**Segredos em log** — `#` privados na entidade (`JSON.stringify` devolve `{}`),
`toPersistenceError` em todo catch de repositório, `BestEffortEmailSender` loga
subject e nunca body. **Limpo.**

---

## Triagem dos minors adiados no ledger

| Minor do ledger | Situação | Veredito |
|---|---|---|
| T2 — `NUMERIC_CODE='000000'` duplicado em specs | **NÃO fechado** por `ae67907` | **Pode ficar.** É stub inerte de porta em quatro suítes que não exercitam `numericCode`. Introduzir uma convenção de fake compartilhado é scope creep, como a própria revisão da T2 concluiu. Vale uma linha no `TODO.md`. |
| T7 — dois testes byte-idênticos no issuer | fechado em `ae67907` | ok |
| T8 — comentário `AuthConfig` em `main/container.ts` | fechado | ok |
| T8 — `existing.email` vs `email` da request | fechado, com o porquê no lugar | ok, e era o mais importante dos sete: era o único com consequência funcional |
| T8 — asserir o corpo exato do `202` | fechado (`NULL_BODY` + content-type) | ok |
| T9 — docstring de `session-tokens.ts` | fechado | ok |
| T11 — dois testes idênticos em `change-password.spec.ts` | fechado, mantendo a racional mais completa | ok |
| T12 — nome "byte-for-byte" mentindo | fechado (renomeado para o que de fato compara) | ok |
| T12 — `messageCount` redundante | fechado | ok |

**Nenhum dos minors adiados bloqueia o merge.** O que bloqueia é C1, e ele não estava
no ledger — não foi adiado, não foi visto.

---

## Rulings do ledger com os quais discordo

**Discordo de um:**

> *T13 — "a nota de acesso do Mailpit não tem casa versionada: `docs/local.md` é
> gitignored e este repo não tem README. Não vale inventar um README."*

O `docs/local.md` é gitignored mesmo (`.gitignore:147`), e a conclusão sobre o README
é razoável. Mas o ruling parou uma casa antes da resposta: **`.env.example` é
versionado, é lido por todo mundo que sobe o projeto, e já documenta toda outra
manopla do sistema.** É a casa óbvia — e o mesmo bloco resolveria I3, que é o buraco
maior que este ruling deixou passar. Não é que a nota do Mailpit não tivesse casa; é
que a busca por uma casa não passou pelo arquivo de configuração de exemplo.

**Concordo, com ressalva de escopo, com um:**

> *T8 — "uma falha de envio continua propagando do `register`, como o §9.5 decidiu,
> apesar do oráculo residual."*

O raciocínio está certo e o descarte do `BestEffortEmailSender` aqui está certo:
`202` para sempre com SMTP quebrado é pior. A ressalva é que o ruling e o §12.7 falam
só do `register`, e o `resend` tem a mesma forma e não foi coberto — é I2 acima.
Estender o registro, não reverter a decisão.

**Concordo com todos os demais**, e dois merecem nota por serem bons:

- **`MAIL_HOST`/`MAIL_PORT`/`MAIL_FROM` como `.optional()` com o default no
  `.transform()` final.** É a única forma que deixa o `superRefine` ver ausência de
  verdade, e o comentário em `env.ts:195-199` explica isso melhor do que o ruling.
  O tipo `Env` exportado sai sem `undefined` nesses campos, o que era o risco.
- **`confirmEmail` tem de aceitar `refreshTransport` (decisão 12).** O ruling está
  certo e a spec §6.6 foi emendada honestamente, dizendo que o silêncio original foi
  lido como decisão e não era. É o tipo de correção que o processo existe para pegar.

Os rulings de `ORDER BY created_at DESC LIMIT 1`, do quarto parâmetro `ErrorLogger`
estreito, do alargamento para `AuthContainerConfig`, de manter os códigos
`EMAIL_NOT_VERIFIED` / `EMAIL_VERIFICATION_FAILED`, de manter o e-mail "você já tem
conta" sem cooldown por endereço, de apagar `CREATED_STATUS`/`CONFLICT_STATUS`, e de
deixar a integração conscientemente vermelha da T8 até a T12 — todos me parecem
corretos e estão bem justificados no lugar certo.

---

## Conferência da documentação contra o código

| Afirmação | Verificação |
|---|---|
| `DECISIONS.md` 25 — `register` responde `202` sempre, sem `id`, sem `409` | Confere. `register.ts:80` declara só `202: z.null()`, `400`, `429`, `503`. `EmailAlreadyInUseError` continua sendo lançado pelo repositório e só perdeu o consumidor HTTP. |
| `DECISIONS.md` 26 — sem backfill, com ressalva normativa | Confere, e a ressalva está escrita com a força certa. Nenhuma migration de dados na branch. |
| `DECISIONS.md` 13 emendada — 403 / 422 | Confere com `error-handler.ts:61-68` e com as duas classes de erro. |
| Spec do UoW §8 emendada — thunk `deliver`, retry × rollback | Confere com `email-verification-issuer.ts:44-68` e com os dois use cases. |
| Spec do UoW §9 emendada — escrita no `Pick` quando o §8 a manda para fora | Confere: `confirm-email.ts:48-51` é o caso, e o porquê está na declaração, como a emenda manda. |
| `ARCHITECTURE.md` §11 — `requireTLS` falha em silêncio; `sendMail` rejeita destinatário único recusado | Confere com `smtp-email-sender.ts:35-49` e com o `superRefine` de produção. |
| `STRUCTURE.md` — `notifications/` | Parcial: entrou na árvore e na tabela, **não** entrou no glob da regra de fronteira (m2), e a linha de `providers/` ficou desatualizada (m3). |
| Spec §6.6 emendada — `refreshTransport` no `confirm` | Confere com `confirm-email.ts:54-60` e com `refresh-cookie.ts:21-27`, que agora diz "três endpoints". |
| Spec §11 — três afirmações, duas medidas | Confere: o teste permanente do `transaction-runner` existe, e o `?? 0` do `consume` está lá com o comentário da medição. A terceira (timing do `register`) continua suposta — e I1 mostra que ela é **falsa** para o `resend`, que a spec nem considerou. |
| `.env.example` | **Não confere** — I3. |

---

## Se for para consertar antes do merge, nesta ordem

1. **C1** — a escrita da senha no ramo não verificado, mais um teste unitário e uma
   frase no §6.1 da spec.
2. **I3** — bloco `MAIL_*` + verificação + rate limits no `.env.example`, com a nota
   do Mailpit.
3. **I1 / I2** — corrigir os dois comentários que afirmam paridade de latência, e
   estender o §12.7 para cobrir `resend`. Nenhuma mudança de comportamento.
4. **m1** — o regex derivado de `VERIFICATION_CODE_DIGITS`.
5. **m2 / m3** — as duas linhas de `STRUCTURE.md`.

m4 a m7 podem ir junto ou ficar para a fatia de recuperação de senha, que vai mexer
nos mesmos arquivos.

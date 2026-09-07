# Módulo `auth`

Autenticação e sessão. É o único módulo que sabe o que é uma credencial: cuida
de cadastro, verificação de e-mail, login, sessão (via refresh token), troca de
senha e logout. Outros módulos só recebem o `id` do usuário já autenticado — não
importam nada daqui.

Este documento é para quem **consome** ou **lê** o `auth` e quer entender o
fluxo. Detalhe de implementação e o porquê de cada decisão estão em
`docs/superpowers/specs/` e no `DECISIONS.md`.

---

## Endpoints

Todos sob o prefixo `/auth`.

| Endpoint | O que faz | Precisa de token? |
|---|---|---|
| `POST /register` | Inicia o cadastro de um e-mail e envia um código | não |
| `POST /email/verify/resend` | Reenvia o código de verificação | não |
| `POST /email/verify` | Confirma o e-mail com o código + a senha escolhida; **cria a conta** e abre a sessão | não |
| `POST /login` | Autentica por e-mail e senha; abre a sessão | não |
| `POST /refresh` | Rotaciona o refresh token (renova a sessão) | refresh token |
| `POST /logout` | Encerra esta sessão | refresh token |
| `POST /logout-all` | Encerra **todas** as sessões da conta | access token |
| `POST /password` | Troca a senha; encerra as outras sessões | access token |
| `POST /password/forgot` | Inicia a recuperação de senha; envia um token por e-mail | não |
| `POST /password/reset` | Redefine a senha com o token; encerra **todas** as sessões | não |
| `GET /me` | Perfil do usuário autenticado | access token |

Rota protegida = manda o access token no header `Authorization: Bearer <token>`.
Sem ele, ou com ele inválido/expirado, a resposta é `401`.

---

## Fluxos

### Cadastro — a conta nasce no passo 3

1. **`POST /auth/register`** — corpo `{ email }`. Responde **`202` sempre**, sem
   corpo. Um código de 6 dígitos é enviado para o endereço. **Nenhuma conta é
   criada ainda** — só um registro pendente, que expira em 15 minutos.

   A resposta é idêntica para um endereço livre, um endereço com cadastro em
   andamento e um endereço que já tem conta. O que muda é **o e-mail que o
   endereço recebe** (um código, ou um aviso "alguém tentou criar conta com seu
   endereço"). Isso é deliberado: ninguém descobre por este endpoint se um
   e-mail tem conta.

2. **`POST /auth/email/verify/resend`** *(opcional)* — corpo `{ email }`.
   Responde `202` sempre. Reenvia o código para um cadastro em andamento, uma
   vez por minuto no máximo.

3. **`POST /auth/email/verify`** — corpo
   `{ email, code, password, refreshTransport? }`. Responde `200` com
   `{ accessToken, refreshToken? }`. **Aqui a conta é criada**, já verificada,
   com **a senha enviada neste request**, e a sessão é aberta.

   Código inexistente, errado, expirado ou com tentativas esgotadas (5) →
   **`422 EMAIL_VERIFICATION_FAILED`**, um erro só para todos os casos.

**Por que a senha só entra no passo 3:** o código só chega na caixa do dono do
endereço, então quem completa a confirmação é quem escolhe a senha. Isso fecha o
*account pre-hijacking* — um atacante não consegue fazer a conta da vítima nascer
com uma senha que ele conhece.

### Login

**`POST /auth/login`** — corpo `{ email, password, refreshTransport? }`.
Responde `200` com `{ accessToken, refreshToken? }`.

- **`401 INVALID_CREDENTIALS`** — e-mail ou senha errados. Não diz qual.
- **`403 EMAIL_NOT_VERIFIED`** — credencial certa, e-mail ainda não confirmado.
  Na prática toda conta nasce verificada (passo 3 do cadastro); este gate fica
  como defesa em profundidade e para o login social futuro.

### Sessão — dois tokens

- **access token** — JWT de vida curta (1 h). Autoriza as rotas protegidas.
  Verificado por assinatura, sem ir ao banco.
- **refresh token** — valor opaco de vida longa (60 dias, deslizante). Carrega a
  sessão. Volta no corpo da resposta **ou** num cookie `HttpOnly`, conforme
  `refreshTransport` (`"body"` — padrão — ou `"cookie"`).

**`POST /auth/refresh`** — corpo `{ refreshToken? }` (ou o cookie). **Rotaciona**:
cada uso invalida o token apresentado e devolve um par novo. Reapresentar um
token já rotacionado (fora de uma janela de graça de 30 s) é tratado como
**reuso** — a "família" inteira daquela sessão é revogada e a resposta é `401`.

Cada login abre uma **família própria**. Encerrar a sessão num aparelho não
afeta os outros.

### Troca de senha

**`POST /auth/password`** *(access token)* — corpo
`{ currentPassword, newPassword, refreshTransport? }`. Responde `200` com um par
novo. Exige a senha atual (`422 INVALID_CURRENT_PASSWORD` se errada), **encerra
todas as outras sessões** e envia um e-mail avisando o dono da conta.

### Recuperação de senha

**`POST /auth/password/forgot`** — corpo `{ email }`. Responde **`202` sempre**,
sem corpo. Se o endereço tem conta, um token de reset vai para a caixa dele. Se
não tem, **nada acontece** — mesma resposta. Um token vivo por conta, substituído
a cada `forgot`, com TTL de 30 minutos. Resgate bloqueado por cooldown de 60
segundos.

**`POST /auth/password/reset`** — corpo `{ token, newPassword }`. Redefine a
senha, **revoga todas as sessões** da conta e responde `204` sem corpo. Token
inexistente / errado / expirado / já usado → um erro só, genérico (`422
PASSWORD_RESET_FAILED`). A resposta não carrega tokens — o cliente entra de novo
com a senha recém-definida.

O token é um **valor opaco de 256 bits**, determinístico para lookup por índice
único. Código de 6 dígitos não seria seguro neste contexto (grau de takeover) e
teto de tentativas apertado paga proteção fraca contra botnet distribuída — 256
bits fecham força bruta por construção.

### Logout

- **`POST /auth/logout`** — corpo `{ refreshToken? }` (ou o cookie). Responde
  `204`. Revoga a família inteira daquele token.
- **`POST /auth/logout-all`** *(access token)* — responde `204`. Revoga todas as
  famílias da conta.

### Perfil

**`GET /auth/me`** *(access token)* — responde `200` com
`{ id, email, emailVerifiedAt, createdAt }`. O hash da senha nunca sai daqui.

---

## Formato de erro

Todo erro tem a mesma forma:

```jsonc
{
  "error": {
    "code": "INVALID_CREDENTIALS",   // SCREAMING_SNAKE_CASE, estável — é nisto que o cliente ramifica
    "message": "Credenciais inválidas", // para log/debug, NÃO para mostrar ao usuário
    "details": [ { "field": "email", "code": "INVALID_FORMAT" } ], // só em erro de validação
    "traceId": "01JXYZ..."
  }
}
```

`400` cobre payload malformado (inclui um campo desconhecido no `register`, que
tem schema estrito). `429` vem do rate limit por IP — cada rota sensível tem o
próprio teto. `503` (com `Retry-After`) só aparece em rotas que abrem transação,
quando um conflito no banco sobrevive às retentativas.

---

## O que este módulo **não** faz (ainda)

- **Login social / OAuth** (Google) — decisões já tomadas no `DECISIONS.md §6`,
  fatia futura.
- **Deleção de conta.**

---

## Garantias que um consumidor pode assumir

- `register` e `resend` **sempre** respondem `202` — nunca é possível enumerar
  contas por eles.
- `confirm` tem **um erro só** (`422 EMAIL_VERIFICATION_FAILED`) para todos os
  modos de falha de código.
- `forgot` **sempre** responde `202` — endereço com ou sem conta, resposta
  idêntica.
- `reset` tem **um erro só** (`422 PASSWORD_RESET_FAILED`) para todos os modos
  de falha de token.
- A conta só existe **depois** da confirmação; antes disso, `login` naquele
  e-mail responde `401` (a conta não existe).
- O hash da senha nunca aparece em resposta nem em log.
- `code` de erro é contrato estável; `message` não é.

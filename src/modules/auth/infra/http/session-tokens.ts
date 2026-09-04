import { z } from 'zod'

/**
 * What every endpoint that hands out a session answers with: `login`, `refresh`
 * and `change-password`.
 *
 * Extracted at the third copy. It is public contract, and three literal
 * duplicates of a contract drift — one of them gains a field, the others do
 * not, and nothing fails until a client notices.
 *
 * `refreshToken` is absent in cookie mode. Optional rather than two separate
 * schemas because declaring a status makes the serializer VALIDATE the body
 * against it (§7 of `ARCHITECTURE.md`), and a shape it cannot serialize answers
 * 500 instead of the intended status.
 */
export const sessionTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
})

import { randomUUID } from 'node:crypto'
import type { IIdGenerator } from '#shared/providers/id-generator'

/**
 * UUIDv4. Node 24 has no v7: `randomUUID({ version: 7 })` **silently ignores**
 * the option and returns a v4 — verified on both 24.16.0 and 24.19.0. Postgres
 * 18.4 does have a native `uuidv7()`, but that sits on the side R7 keeps the
 * pure layer away from.
 *
 * Moving to v7 later means editing this file and emitting a migration that
 * changes the column default — which is exactly what the contract bought.
 */
export class UuidIdGenerator implements IIdGenerator {
  generate(): string {
    return randomUUID()
  }
}

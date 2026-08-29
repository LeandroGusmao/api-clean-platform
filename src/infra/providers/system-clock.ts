import type { IClock } from '#shared/ports/clock'

export class SystemClock implements IClock {
  now(): Date {
    return new Date()
  }
}

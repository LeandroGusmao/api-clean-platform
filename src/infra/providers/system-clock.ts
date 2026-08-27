import type { IClock } from '#shared/providers/clock'

export class SystemClock implements IClock {
  now(): Date {
    return new Date()
  }
}

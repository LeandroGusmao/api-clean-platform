import { beforeAll } from 'vitest'
import { flushRedis } from './redis.js'

// Runs once per spec file, before any of its cases: a file starts from zero
// whatever the previous one spent against the same route and address.
beforeAll(flushRedis)

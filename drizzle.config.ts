import { defineConfig } from 'drizzle-kit'

// One file per table, named after the table. The directory already says
// "Drizzle schema", so the file name does not repeat it.
const SCHEMA_GLOB = './src/modules/*/infra/drizzle/schema/*.ts'
const MIGRATIONS_OUT_DIR = './drizzle'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run drizzle-kit')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: SCHEMA_GLOB,
  out: MIGRATIONS_OUT_DIR,
  dbCredentials: { url: databaseUrl },
})

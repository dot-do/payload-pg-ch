#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg

const __dirname = dirname(fileURLToPath(import.meta.url))

function getConnectionString(): string {
  // Check args first: --url=...
  const urlArg = process.argv.find(a => a.startsWith('--url='))
  if (urlArg) return urlArg.split('=').slice(1).join('=')

  // Then env vars (in priority order)
  const envUrl = process.env.POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? process.env.TEST_DATABASE_URL
  if (envUrl) return envUrl

  console.error('Error: No database URL found.')
  console.error('Set POSTGRES_URL in .env or pass --url=postgresql://...')
  process.exit(1)
}

function needsSSL(url: string): boolean {
  try {
    const parsed = new URL(url)
    return !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

// Load .env if present
try {
  const envFile = readFileSync(join(process.cwd(), '.env'), 'utf-8')
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx)
      const val = trimmed.slice(eqIdx + 1)
      if (!process.env[key]) process.env[key] = val
    }
  }
} catch { /* no .env, that's fine */ }

const command = process.argv[2] ?? 'up'
const connectionString = getConnectionString()
const ssl = needsSSL(connectionString) ? { rejectUnauthorized: false } : undefined
const pool = new Pool({ connectionString, ssl, max: 3 })

const SQL_DIR = join(__dirname, '..', '..', 'sql', 'pg')

const DDL_FILES = [
  '001_ns.sql',
  '002_data.sql',
  '003_actions.sql',
  '004_rels.sql',
  '005_events.sql',
  '006_search.sql',
]

async function up() {
  console.log('Applying schema to', connectionString.replace(/:[^@]+@/, ':***@'))

  // Enable pgvector
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    console.log('  ✓ pgvector extension')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log('  ⚠ pgvector:', msg)
  }

  for (const file of DDL_FILES) {
    const sql = readFileSync(join(SQL_DIR, file), 'utf-8')
    try {
      await pool.query(sql)
      console.log(`  ✓ ${file}`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('already exists')) {
        console.log(`  · ${file} (already exists)`)
      } else {
        console.error(`  ✗ ${file}: ${msg}`)
        process.exit(1)
      }
    }
  }

  // Record migration
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      batch INT NOT NULL DEFAULT 1,
      created TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(
    `INSERT INTO migrations (name, batch) VALUES ($1, 1) ON CONFLICT DO NOTHING`,
    ['initial'],
  )

  console.log('\n✓ Schema applied successfully')
}

async function down() {
  console.log('Dropping schema from', connectionString.replace(/:[^@]+@/, ':***@'))

  const tables = ['search', 'events', 'rels', 'actions', 'data', 'ns', 'migrations']
  for (const table of tables) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
    console.log(`  ✓ dropped ${table}`)
  }

  console.log('\n✓ Schema dropped')
}

async function status() {
  console.log('Schema status for', connectionString.replace(/:[^@]+@/, ':***@'))

  const tables = ['ns', 'data', 'actions', 'rels', 'events', 'search', 'migrations']
  for (const table of tables) {
    try {
      const r = await pool.query(`SELECT count(*) AS cnt FROM ${table}`)
      console.log(`  ✓ ${table}: ${r.rows[0].cnt} rows`)
    } catch {
      console.log(`  ✗ ${table}: not found`)
    }
  }

  // Check pgvector
  try {
    await pool.query('SELECT 1 FROM pg_extension WHERE extname = $1', ['vector'])
    console.log('  ✓ pgvector: enabled')
  } catch {
    console.log('  ✗ pgvector: not available')
  }
}

async function seed() {
  console.log('Seeding default namespace...')

  const existing = await pool.query(`SELECT id FROM ns WHERE uri = 'localhost'`)
  if (existing.rows.length > 0) {
    console.log(`  · namespace 'localhost' already exists (id=${existing.rows[0].id})`)
  } else {
    const r = await pool.query(
      `INSERT INTO ns (uri, name, kind) VALUES ('localhost', 'Development', 'production') RETURNING id`,
    )
    console.log(`  ✓ namespace 'localhost' created (id=${r.rows[0].id})`)
  }

  console.log('\n✓ Seed complete')
}

async function main() {
  try {
    switch (command) {
      case 'up':
        await up()
        break
      case 'down':
        await down()
        break
      case 'status':
        await status()
        break
      case 'seed':
        await up()
        await seed()
        break
      case 'fresh':
        await down()
        await up()
        break
      default:
        console.log(`Usage: migrate [up|down|status|seed|fresh]

Commands:
  up      Apply schema (default)
  down    Drop all tables
  status  Show table status
  seed    Apply schema + create default namespace
  fresh   Drop and recreate schema

Options:
  --url=postgresql://...  Database connection URL

Environment variables (in priority order):
  POSTGRES_URL
  DATABASE_URL
  TEST_DATABASE_URL
`)
    }
  } finally {
    await pool.end()
  }
}

main().catch(e => {
  console.error('Fatal:', e.message)
  process.exit(1)
})

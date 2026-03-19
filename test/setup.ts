import pg from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { Pool } = pg

const TEST_CONNECTION = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let pool: InstanceType<typeof Pool> | null = null

export function getTestPool(): InstanceType<typeof Pool> {
  if (!pool) {
    pool = new Pool({ connectionString: TEST_CONNECTION, max: 5 })
  }
  return pool
}

export async function setupTestSchema(): Promise<void> {
  const p = getTestPool()

  // Drop and recreate all tables
  await p.query(`
    DROP TABLE IF EXISTS search CASCADE;
    DROP TABLE IF EXISTS pending CASCADE;
    DROP TABLE IF EXISTS log CASCADE;
    DROP TABLE IF EXISTS rels CASCADE;
    DROP TABLE IF EXISTS actions CASCADE;
    DROP TABLE IF EXISTS data CASCADE;
    DROP TABLE IF EXISTS ns CASCADE;
    DROP TABLE IF EXISTS migrations CASCADE;
  `)

  // Apply DDL files in order
  const sqlDir = join(import.meta.dirname, '..', 'sql', 'pg')
  const files = [
    '001_ns.sql',
    '002_data.sql',
    '003_actions.sql',
    '004_rels.sql',
    '005_log.sql',
    '006_pending.sql',
    '007_search.sql',
  ]

  for (const file of files) {
    const sql = readFileSync(join(sqlDir, file), 'utf-8')
    await p.query(sql)
  }
}

export async function cleanupTestData(): Promise<void> {
  const p = getTestPool()
  await p.query(`DELETE FROM rels`)
  await p.query(`DELETE FROM pending`)
  await p.query(`DELETE FROM log`)
  await p.query(`DELETE FROM actions`)
  await p.query(`DELETE FROM data`)
  await p.query(`DELETE FROM ns`)
}

export async function teardownTestPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

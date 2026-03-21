import pg from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { Pool } = pg

const TEST_CONNECTION = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let pool: InstanceType<typeof Pool> | null = null
let schemaReady = false

export function getTestPool(): InstanceType<typeof Pool> {
  if (!pool) {
    pool = new Pool({ connectionString: TEST_CONNECTION, max: 5 })
  }
  return pool
}

export async function setupTestSchema(): Promise<void> {
  if (schemaReady) return
  const p = getTestPool()

  // Check if schema already exists (applied externally)
  const exists = await p.query(`SELECT 1 FROM pg_tables WHERE tablename = 'data'`)
  if (exists.rows.length > 0) {
    schemaReady = true
    return
  }

  // Apply DDL files in order
  const sqlDir = join(import.meta.dirname, '..', 'sql', 'pg')
  const files = [
    '001_data.sql',
    '002_rels.sql',
    '003_actions.sql',
    '004_events.sql',
    '005_search.sql',
  ]

  for (const file of files) {
    const sql = readFileSync(join(sqlDir, file), 'utf-8')
    await p.query(sql)
  }

  schemaReady = true
}

export async function cleanupTestData(): Promise<void> {
  const p = getTestPool()
  await p.query(`DELETE FROM search`)
  await p.query(`DELETE FROM events`)
  await p.query(`DELETE FROM rels`)
  await p.query(`DELETE FROM actions`)
  await p.query(`DELETE FROM data`)
}

/** Insert a namespace doc into the data table (replaces old INSERT INTO ns) */
export async function createTestNs(uri: string, name: string): Promise<string> {
  const p = getTestPool()
  await p.query(
    `INSERT INTO data (ns, type, id, name, data, rand) VALUES ($1, 'namespaces', $1, $2, '{}', 0)
     ON CONFLICT DO NOTHING`,
    [uri, name],
  )
  return uri
}

export async function teardownTestPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

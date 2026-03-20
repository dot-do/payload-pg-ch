import pg from 'pg'

const { Pool, types } = pg

// Parse BIGINT (OID 20) as number instead of string
// Safe for IDs up to Number.MAX_SAFE_INTEGER (9007199254740991)
types.setTypeParser(20, (val: string) => parseInt(val, 10))

// Re-export concrete types derived from the runtime Pool constructor
export type PgPool = InstanceType<typeof Pool>
export type PgPoolClient = pg.PoolClient

export interface PoolConfig {
  connectionString: string
  max?: number
  ssl?: boolean | { rejectUnauthorized?: boolean }
}

function needsSSL(url: string): boolean {
  try {
    const parsed = new URL(url)
    return !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

export function createPool(config: string | PoolConfig): PgPool {
  const opts = typeof config === 'string' ? { connectionString: config } : config
  const connStr = opts.connectionString

  // Auto-detect SSL for non-localhost connections
  let ssl = opts.ssl
  if (ssl === undefined && needsSSL(connStr)) {
    ssl = { rejectUnauthorized: false }
  }

  return new Pool({ connectionString: connStr, max: opts.max ?? 20, ssl: ssl || undefined })
}

export async function transaction<T>(
  pool: PgPool,
  fn: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      console.error('ROLLBACK failed:', rollbackErr)
    }
    throw err
  } finally {
    client.release()
  }
}

export interface QueryResult<T> {
  rows: T[]
  rowCount: number | null
}

export async function query<T>(
  client: PgPoolClient | PgPool,
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const result = await client.query(sql, params)
  return { rows: result.rows as T[], rowCount: result.rowCount }
}

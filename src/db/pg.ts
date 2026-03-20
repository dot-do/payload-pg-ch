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
}

export function createPool(config: string | PoolConfig): PgPool {
  const opts = typeof config === 'string' ? { connectionString: config } : config
  return new Pool({ ...opts, max: opts.max ?? 20 })
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

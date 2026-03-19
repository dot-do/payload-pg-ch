import pg from 'pg'

const { Pool, types } = pg

// Parse BIGINT (OID 20) as number instead of string
// Safe for IDs up to Number.MAX_SAFE_INTEGER (9007199254740991)
types.setTypeParser(20, (val: string) => parseInt(val, 10))

export type { Pool, PoolClient } from 'pg'

export interface PoolConfig {
  connectionString: string
  max?: number
}

export function createPool(config: string | PoolConfig): InstanceType<typeof Pool> {
  const opts = typeof config === 'string' ? { connectionString: config } : config
  return new Pool({ ...opts, max: opts.max ?? 20 })
}

export async function transaction<T>(
  pool: InstanceType<typeof Pool>,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
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
  client: pg.PoolClient | InstanceType<typeof Pool>,
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const result = await client.query(sql, params)
  return { rows: result.rows as T[], rowCount: result.rowCount }
}

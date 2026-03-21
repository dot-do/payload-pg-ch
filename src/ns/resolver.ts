import type { PgPool } from '../db/pg.js'
import type { DataRow } from '../types.js'
import { query } from '../db/pg.js'

/**
 * Resolves namespace strings by querying `data WHERE type = 'namespaces'`.
 * No separate `ns` table — namespaces are just documents in the data table.
 */
export class NsResolver {
  /** ns string → namespace DataRow */
  private cache = new Map<string, DataRow>()
  private pool: PgPool
  private refreshInterval: ReturnType<typeof setInterval> | null = null

  constructor(pool: PgPool) {
    this.pool = pool
  }

  async start(intervalMs: number = 30_000): Promise<void> {
    await this.refresh()
    this.refreshInterval = setInterval(() => this.refresh(), intervalMs)
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }
  }

  async refresh(): Promise<void> {
    const result = await query<DataRow>(
      this.pool,
      `SELECT * FROM data WHERE type = 'namespaces'`,
    )
    this.cache.clear()
    for (const row of result.rows) {
      this.cache.set(row.ns, row)
    }
  }

  /**
   * Longest prefix match against cached namespace `ns` column values.
   * E.g. host='acme.com', path='/blog/my-post' tries:
   *   'acme.com/blog/my-post' → 'acme.com/blog' → 'acme.com'
   */
  resolve(host: string, path: string = '/'): DataRow | null {
    const segments = `${host}${path}`.split('/').filter(Boolean)
    const candidates = [host]
    let current = host
    for (const seg of segments.slice(1)) {
      current = `${current}/${seg}`
      candidates.push(current)
    }

    // Longest prefix match
    let best: DataRow | null = null
    for (const candidate of candidates) {
      const ns = this.cache.get(candidate)
      if (ns) best = ns
    }
    return best
  }

  resolveFromRequest(req: { headers: { host?: string }; url?: string }): DataRow | null {
    const host = req.headers.host ?? 'localhost'
    const path = req.url ? new URL(req.url, `http://${host}`).pathname : '/'
    return this.resolve(host, path)
  }

  /**
   * Get a namespace doc by its ns string.
   * Returns from cache first, falls back to DB query.
   */
  getByNs(ns: string): DataRow | null {
    return this.cache.get(ns) ?? null
  }

  async fetchByNs(ns: string): Promise<DataRow | null> {
    const cached = this.cache.get(ns)
    if (cached) return cached
    const result = await query<DataRow>(
      this.pool,
      `SELECT * FROM data WHERE type = 'namespaces' AND ns = $1 LIMIT 1`,
      [ns],
    )
    const row = result.rows[0] ?? null
    if (row) {
      this.cache.set(row.ns, row)
    }
    return row
  }

  /**
   * Get the parent ns string from a namespace doc's meta JSONB.
   */
  getParentNs(ns: string): string | null {
    const row = this.cache.get(ns)
    if (!row) return null
    const meta = row.meta as Record<string, unknown> | null
    return (meta?._parent as string) ?? null
  }

  getAllChildren(parentNs: string): DataRow[] {
    return Array.from(this.cache.values()).filter(row => {
      const meta = row.meta as Record<string, unknown> | null
      return meta?._parent === parentNs
    })
  }
}

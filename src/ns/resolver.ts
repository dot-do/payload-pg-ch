import type { PgPool } from '../db/pg.js'
import type { NsRow } from '../types.js'
import { query } from '../db/pg.js'

export class NsResolver {
  private cache = new Map<string, NsRow>()
  private byId = new Map<number, NsRow>()
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
    const result = await query<NsRow>(this.pool, `SELECT * FROM ns`)
    this.cache.clear()
    this.byId.clear()
    for (const row of result.rows) {
      this.cache.set(row.uri, row)
      this.byId.set(row.id, row)
    }
  }

  resolve(host: string, path: string = '/'): NsRow | null {
    // Walk up the path: 'acme.com/blog/my-post' → 'acme.com/blog' → 'acme.com'
    const segments = `${host}${path}`.split('/').filter(Boolean)
    const candidates = [host]
    let current = host
    for (const seg of segments.slice(1)) {
      current = `${current}/${seg}`
      candidates.push(current)
    }

    // Longest prefix match
    let best: NsRow | null = null
    for (const candidate of candidates) {
      const ns = this.cache.get(candidate)
      if (ns) best = ns
    }
    return best
  }

  resolveFromRequest(req: { headers: { host?: string }; url?: string }): NsRow | null {
    const host = req.headers.host ?? 'localhost'
    const path = req.url ? new URL(req.url, `http://${host}`).pathname : '/'
    return this.resolve(host, path)
  }

  getById(id: number): NsRow | null {
    return this.byId.get(id) ?? null
  }

  getAllByParent(parentId: number): NsRow[] {
    return Array.from(this.byId.values()).filter(ns => ns.parent === parentId)
  }
}

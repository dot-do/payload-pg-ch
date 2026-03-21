import type { IDocumentAdapter } from '../adapter-interface.js'
import type { Sqid, Where, RequestMeta } from '../types.js'

export interface RemoteAdapterConfig {
  /** Base URL of the platform.do RPC server */
  url: string
  /** JWT token for authentication (scoped to namespace) */
  token: string | (() => string | Promise<string>)
  /** Namespace (resolved from hostname or explicit) */
  ns: string
  /** Custom fetch implementation (for testing or edge runtimes) */
  fetch?: typeof globalThis.fetch
}

/**
 * Remote document adapter that implements IDocumentAdapter over HTTP.
 * Talks to a platform.do RPC server instead of directly to PG/CH.
 * No database credentials needed — just a JWT.
 */
export class RemoteDocumentAdapter implements IDocumentAdapter {
  readonly defaultNs: string
  private baseUrl: string
  private tokenSource: string | (() => string | Promise<string>)
  private _fetch: typeof globalThis.fetch

  constructor(config: RemoteAdapterConfig) {
    this.baseUrl = config.url.replace(/\/$/, '')
    this.tokenSource = config.token
    this.defaultNs = config.ns
    this._fetch = config.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private async getToken(): Promise<string> {
    if (typeof this.tokenSource === 'function') {
      return this.tokenSource()
    }
    return this.tokenSource
  }

  private async rpc<T>(method: string, args: unknown): Promise<T> {
    const token = await this.getToken()
    const res = await this._fetch(`${this.baseUrl}/rpc/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`RPC ${method} failed (${res.status}): ${text}`)
    }

    return res.json() as Promise<T>
  }

  // --- Lifecycle ---

  async init(): Promise<void> {
    // Server handles initialization — client just verifies connectivity
    await this.rpc<{ ok: boolean }>('ping', {})
  }

  async destroy(): Promise<void> {
    // No-op — no persistent connections to clean up
  }

  // --- CRUD ---

  async create(args: {
    ns: string
    type: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }> {
    return this.rpc('create', args)
  }

  async find(args: {
    ns: string
    type: string
    where?: Where
    sort?: string
    limit?: number
    offset?: number
  }): Promise<{ docs: Array<{ id: Sqid } & Record<string, unknown>>; total: number }> {
    return this.rpc('find', args)
  }

  async findOne(args: {
    ns: string
    type: string
    where?: Where
    id?: string
  }): Promise<({ id: Sqid } & Record<string, unknown>) | null> {
    return this.rpc('findOne', args)
  }

  async updateOne(args: {
    ns: string
    type: string
    id: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }> {
    return this.rpc('updateOne', args)
  }

  async deleteMany(args: {
    ns: string
    type: string
    where: Where
    actor?: number
    meta?: RequestMeta
  }): Promise<{ deleted: number }> {
    return this.rpc('deleteMany', args)
  }

  // --- Extended operations ---

  async checkSchema(): Promise<boolean> {
    const result = await this.rpc<{ ok: boolean }>('checkSchema', {})
    return result.ok
  }

  async ensureNamespace(ns: string): Promise<void> {
    await this.rpc('ensureNamespace', { ns })
  }

  async findDistinct(args: {
    ns: string
    collection: string
    field: string
    where?: Where
    limit?: number
    offset?: number
  }): Promise<{ values: Record<string, unknown>[]; total: number }> {
    return this.rpc('findDistinct', args)
  }
}

/**
 * Create a remote adapter for use as a Payload database adapter.
 *
 * Usage:
 * ```ts
 * import { remoteAdapter } from 'payload-pg-ch/remote'
 *
 * export default buildConfig({
 *   db: remoteAdapter({
 *     url: 'https://platform.do',
 *     token: process.env.PLATFORM_TOKEN,
 *     ns: req.headers.host, // or explicit namespace
 *   }),
 *   collections: [...],
 * })
 * ```
 */
export function createRemoteAdapter(config: RemoteAdapterConfig): RemoteDocumentAdapter {
  return new RemoteDocumentAdapter(config)
}

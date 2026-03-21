import type { Sqid, Where, RequestMeta } from './types.js'

/**
 * The core adapter interface used by the Payload database adapter bridge.
 * Implemented by both DocumentAdapter (local PG+CH) and RemoteDocumentAdapter (RPC client).
 */
export interface IDocumentAdapter {
  readonly defaultNs: string

  init(): Promise<void>
  destroy(): Promise<void>

  // --- CRUD ---

  create(args: {
    ns: string
    type: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }>

  find(args: {
    ns: string
    type: string
    where?: Where
    sort?: string
    limit?: number
    offset?: number
  }): Promise<{ docs: Array<{ id: Sqid } & Record<string, unknown>>; total: number }>

  findOne(args: {
    ns: string
    type: string
    where?: Where
    id?: string
  }): Promise<({ id: Sqid } & Record<string, unknown>) | null>

  updateOne(args: {
    ns: string
    type: string
    id: string
    data: Record<string, unknown>
    actor?: number
    meta?: RequestMeta
  }): Promise<{ id: Sqid; doc: unknown }>

  deleteMany(args: {
    ns: string
    type: string
    where: Where
    actor?: number
    meta?: RequestMeta
  }): Promise<{ deleted: number }>

  // --- Extended operations (used by Payload bridge) ---

  /** Check if the schema is ready */
  checkSchema(): Promise<boolean>

  /** Ensure a namespace exists, auto-create if missing */
  ensureNamespace(ns: string): Promise<void>

  /** Find distinct values for a field in a collection */
  findDistinct(args: {
    ns: string
    collection: string
    field: string
    where?: Where
    limit?: number
    offset?: number
  }): Promise<{ values: Record<string, unknown>[]; total: number }>
}

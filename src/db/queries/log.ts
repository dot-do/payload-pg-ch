import type { PgPool, PgPoolClient } from '../pg.js'
import type { LogRow } from '../../types.js'
import { query } from '../pg.js'
import { generateRand } from '../../id/sqids.js'

export interface InsertLogArgs {
  ns: number
  kind: string
  entity?: number | null
  collection?: string | null
  actor?: number | null
  doc?: unknown
  diff?: unknown
  meta?: unknown
  commit?: string | null
  rand: number
}

export async function insertLog(
  tx: PgPoolClient,
  args: InsertLogArgs,
): Promise<LogRow> {
  const result = await query<LogRow>(
    tx,
    `INSERT INTO log (ns, kind, entity, collection, actor, doc, diff, meta, commit, rand)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      args.ns,
      args.kind,
      args.entity ?? null,
      args.collection ?? null,
      args.actor ?? null,
      args.doc ? JSON.stringify(args.doc) : null,
      args.diff ? JSON.stringify(args.diff) : null,
      args.meta ? JSON.stringify(args.meta) : null,
      args.commit ?? null,
      args.rand,
    ],
  )
  return result.rows[0]
}

export async function emit(
  pool: PgPool,
  args: {
    ns: number
    kind: string
    entity?: number | null
    collection?: string | null
    actor?: number | null
    meta?: unknown
  },
): Promise<void> {
  const rand = generateRand()
  await query(
    pool,
    `INSERT INTO log (ns, kind, entity, collection, actor, meta, rand)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.ns,
      args.kind,
      args.entity ?? null,
      args.collection ?? null,
      args.actor ?? null,
      args.meta ? JSON.stringify(args.meta) : null,
      rand,
    ],
  )
}

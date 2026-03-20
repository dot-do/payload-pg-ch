import type { PgPool, PgPoolClient } from '../pg.js'
import type { PendingRow } from '../../types.js'
import { query } from '../pg.js'

export interface InsertPendingArgs {
  ns: number
  entity: number
  collection: string
  title?: string | null
  body?: string | null
  tags?: string[]
  locale?: string | null
}

export async function insertPending(
  tx: PgPoolClient,
  args: InsertPendingArgs,
): Promise<PendingRow> {
  const result = await query<PendingRow>(
    tx,
    `INSERT INTO pending (ns, entity, collection, title, body, tags, locale)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      args.ns,
      args.entity,
      args.collection,
      args.title ?? null,
      args.body ?? null,
      args.tags ?? [],
      args.locale ?? null,
    ],
  )
  return result.rows[0]
}

export async function dequeuePending(
  tx: PgPoolClient,
  limit: number = 10,
): Promise<PendingRow[]> {
  const result = await query<PendingRow>(
    tx,
    `UPDATE pending SET status = 'processing'
     WHERE id IN (
       SELECT id FROM pending
       WHERE status = 'pending'
       ORDER BY created
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit],
  )
  return result.rows
}

export async function completePending(
  tx: PgPoolClient | PgPool,
  id: number,
): Promise<void> {
  await query(tx, `UPDATE pending SET status = 'done' WHERE id = $1`, [id])
}

export async function failPending(
  tx: PgPoolClient | PgPool,
  id: number,
): Promise<void> {
  await query(tx, `UPDATE pending SET status = 'failed' WHERE id = $1`, [id])
}

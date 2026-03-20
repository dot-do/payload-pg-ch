import type pg from 'pg'
import type { ActionRow } from '../../types.js'
import { query } from '../pg.js'
import { generateRand } from '../../id/sqids.js'

export interface EnqueueActionArgs {
  ns: number
  kind: string
  name: string
  input?: unknown
  entity?: number | null
  scheduled?: Date | null
  parent?: number | null
  cap?: number
  rand?: number
}

export async function enqueueAction(
  tx: pg.PoolClient,
  args: EnqueueActionArgs,
): Promise<ActionRow> {
  const rand = args.rand ?? generateRand()
  const result = await query<ActionRow>(
    tx,
    `INSERT INTO actions (ns, kind, name, input, entity, scheduled, parent, cap, rand)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      args.ns,
      args.kind,
      args.name,
      args.input ? JSON.stringify(args.input) : null,
      args.entity ?? null,
      args.scheduled ?? null,
      args.parent ?? null,
      args.cap ?? 3,
      rand,
    ],
  )
  return result.rows[0]
}

export async function dequeueActions(
  tx: pg.PoolClient,
  args: { ns: number; kind?: string; limit?: number },
): Promise<ActionRow[]> {
  const conditions = [
    `ns = $1`,
    `status = 'pending'`,
    `(scheduled IS NULL OR scheduled <= now())`,
  ]
  const params: unknown[] = [args.ns]
  let paramIdx = 2

  if (args.kind) {
    conditions.push(`kind = $${paramIdx++}`)
    params.push(args.kind)
  }

  const limit = args.limit ?? 1
  params.push(limit)

  const sql = `
    UPDATE actions SET status = 'running', started = now(), updated = now()
    WHERE id IN (
      SELECT id FROM actions
      WHERE ${conditions.join(' AND ')}
      ORDER BY created
      LIMIT $${paramIdx}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `

  const result = await query<ActionRow>(tx, sql, params)
  return result.rows
}

export async function checkpointAction(
  tx: pg.PoolClient,
  args: { id: number; step: number; result: unknown },
): Promise<boolean> {
  const result = await query(
    tx,
    `UPDATE actions
     SET steps = steps::jsonb || $1::jsonb, cursor = $2, updated = now()
     WHERE id = $3 AND status IN ('pending', 'running')`,
    [JSON.stringify([args.result]), args.step, args.id],
  )
  return (result.rowCount ?? 0) > 0
}

export async function completeAction(
  pool: pg.Pool | pg.PoolClient,
  args: { id: number; output?: unknown },
): Promise<boolean> {
  const result = await query(
    pool,
    `UPDATE actions
     SET status = 'completed', output = $1, completed = now(), updated = now()
     WHERE id = $2 AND status IN ('pending', 'running')`,
    [args.output ? JSON.stringify(args.output) : null, args.id],
  )
  return (result.rowCount ?? 0) > 0
}

export async function failAction(
  pool: pg.Pool | pg.PoolClient,
  args: { id: number; error: unknown },
): Promise<boolean> {
  // Fail but auto-retry if under cap
  const result = await query(
    pool,
    `UPDATE actions
     SET status = CASE WHEN retries + 1 < cap THEN 'pending' ELSE 'failed' END,
         error = $1,
         retries = retries + 1,
         started = NULL,
         updated = now()
     WHERE id = $2 AND status IN ('pending', 'running')`,
    [JSON.stringify(args.error), args.id],
  )
  return (result.rowCount ?? 0) > 0
}

export async function findAction(
  pool: pg.Pool | pg.PoolClient,
  id: number,
): Promise<ActionRow | null> {
  const result = await query<ActionRow>(pool, `SELECT * FROM actions WHERE id = $1`, [id])
  return result.rows[0] ?? null
}

import type { PgPool, PgPoolClient } from '../pg.js'
import type { ActionRow } from '../../types.js'
import { query } from '../pg.js'
import { generateRand } from '../../id/sqids.js'

export interface EnqueueActionArgs {
  ns: string
  id: string
  type: string
  name: string
  input?: unknown
  entity?: number | null
  scheduled?: Date | null
  deadline?: Date | null
  parent?: number | null
  cap?: number
  rand?: number
}

export async function enqueueAction(
  tx: PgPoolClient,
  args: EnqueueActionArgs,
): Promise<ActionRow> {
  const rand = args.rand ?? generateRand()
  const result = await query<ActionRow>(
    tx,
    `INSERT INTO actions (ns, id, type, name, input, entity, scheduled, deadline, parent, cap, rand)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      args.ns,
      args.id,
      args.type,
      args.name,
      args.input ? JSON.stringify(args.input) : null,
      args.entity ?? null,
      args.scheduled ?? null,
      args.deadline ?? null,
      args.parent ?? null,
      args.cap ?? 3,
      rand,
    ],
  )
  return result.rows[0]
}

export async function dequeueActions(
  tx: PgPoolClient,
  args: { ns: string; type?: string; limit?: number },
): Promise<ActionRow[]> {
  const conditions = [
    `ns = $1`,
    `status = 'pending'`,
    `(scheduled IS NULL OR scheduled <= now())`,
  ]
  const params: unknown[] = [args.ns]
  let paramIdx = 2

  if (args.type) {
    conditions.push(`type = $${paramIdx++}`)
    params.push(args.type)
  }

  const limit = args.limit ?? 1
  params.push(limit)

  const sql = `
    UPDATE actions SET status = 'running', started = now(), updated = now()
    WHERE seq IN (
      SELECT seq FROM actions
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
  tx: PgPoolClient,
  args: { seq: number; step: number; result: unknown },
): Promise<boolean> {
  const result = await query(
    tx,
    `UPDATE actions
     SET steps = steps::jsonb || $1::jsonb, cursor = $2, updated = now()
     WHERE seq = $3 AND status IN ('pending', 'running')`,
    [JSON.stringify([args.result]), args.step, args.seq],
  )
  return (result.rowCount ?? 0) > 0
}

export async function completeAction(
  pool: PgPool | PgPoolClient,
  args: { seq: number; output?: unknown },
): Promise<boolean> {
  const result = await query(
    pool,
    `UPDATE actions
     SET status = 'completed', output = $1, completed = now(), updated = now()
     WHERE seq = $2 AND status IN ('pending', 'running')`,
    [args.output ? JSON.stringify(args.output) : null, args.seq],
  )
  return (result.rowCount ?? 0) > 0
}

export async function failAction(
  pool: PgPool | PgPoolClient,
  args: { seq: number; error: unknown },
): Promise<boolean> {
  const result = await query(
    pool,
    `UPDATE actions
     SET status = CASE WHEN retries + 1 < cap THEN 'pending' ELSE 'failed' END,
         error = $1,
         retries = retries + 1,
         started = NULL,
         updated = now()
     WHERE seq = $2 AND status IN ('pending', 'running')`,
    [JSON.stringify(args.error), args.seq],
  )
  return (result.rowCount ?? 0) > 0
}

export async function findAction(
  pool: PgPool | PgPoolClient,
  seq: number,
  ns?: string,
): Promise<ActionRow | null> {
  if (ns !== undefined) {
    const result = await query<ActionRow>(pool, `SELECT * FROM actions WHERE seq = $1 AND ns = $2`, [seq, ns])
    return result.rows[0] ?? null
  }
  const result = await query<ActionRow>(pool, `SELECT * FROM actions WHERE seq = $1`, [seq])
  return result.rows[0] ?? null
}

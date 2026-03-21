import type { PgPool } from '../pg.js'
import type { EventRow } from '../../types.js'
import { query } from '../pg.js'

/**
 * Emit a non-mutation event (page view, search query, auth event, etc.)
 * Mutation events are captured by CDC on the data table -- no duplication.
 */
export async function emit(
  pool: PgPool,
  args: {
    ns: string
    kind: string
    entity?: number | null
    type?: string | null
    actor?: number | null
    data?: unknown
    meta?: unknown
  },
): Promise<EventRow> {
  const result = await query<EventRow>(
    pool,
    `INSERT INTO events (ns, kind, entity, type, actor, data, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      args.ns,
      args.kind,
      args.entity ?? null,
      args.type ?? null,
      args.actor ?? null,
      args.data ? JSON.stringify(args.data) : null,
      args.meta ? JSON.stringify(args.meta) : null,
    ],
  )
  return result.rows[0]
}

export async function findEvents(
  pool: PgPool,
  args: {
    ns: string
    kind?: string
    entity?: number
    limit?: number
    offset?: number
  },
): Promise<{ rows: EventRow[]; total: number }> {
  const conditions = ['ns = $1']
  const params: unknown[] = [args.ns]
  let paramIdx = 2

  if (args.kind) {
    conditions.push(`kind = $${paramIdx++}`)
    params.push(args.kind)
  }
  if (args.entity) {
    conditions.push(`entity = $${paramIdx++}`)
    params.push(args.entity)
  }

  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  params.push(limit, offset)

  const sql = `
    SELECT *, count(*) OVER() AS total FROM events
    WHERE ${conditions.join(' AND ')}
    ORDER BY created DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `

  const result = await query<EventRow & { total: string }>(pool, sql, params)
  const total = result.rows.length > 0 ? parseInt(result.rows[0].total, 10) : 0
  return {
    rows: result.rows.map(({ total: _t, ...row }) => row as unknown as EventRow),
    total,
  }
}

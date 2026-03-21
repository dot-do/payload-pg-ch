import type { PgPool, PgPoolClient } from '../pg.js'
import type { DataRow } from '../../types.js'
import { query } from '../pg.js'
import { whereToSQL } from '../where.js'
import type { Where } from '../../types.js'

export interface InsertDataArgs {
  ns: number
  collection: string
  slug?: string | null
  doc: unknown
  meta?: unknown
  status?: string | null
  locale?: string | null
  rand: number
  embedding?: number[] | null
}

export async function insertData(
  tx: PgPoolClient,
  args: InsertDataArgs,
): Promise<DataRow> {
  const result = await query<DataRow>(
    tx,
    `INSERT INTO data (ns, collection, slug, doc, meta, status, locale, rand, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      args.ns,
      args.collection,
      args.slug ?? null,
      JSON.stringify(args.doc),
      args.meta ? JSON.stringify(args.meta) : '{}',
      args.status ?? null,
      args.locale ?? null,
      args.rand,
      formatVector(args.embedding),
    ],
  )
  return result.rows[0]
}

export interface UpdateDataArgs {
  ns: number
  id: number
  doc: unknown
  meta?: unknown
  status?: string | null
  locale?: string | null
  embedding?: number[] | null
}

export async function updateData(
  tx: PgPoolClient,
  args: UpdateDataArgs,
): Promise<DataRow> {
  const setClauses = [
    'doc = $1',
    'status = $2',
    'locale = $3',
    'embedding = $4',
    'version = version + 1',
    'updated = now()',
  ]
  const params: unknown[] = [
    JSON.stringify(args.doc),
    args.status ?? null,
    args.locale ?? null,
    formatVector(args.embedding),
  ]
  let paramIdx = 5

  if (args.meta !== undefined) {
    setClauses.push(`meta = $${paramIdx++}`)
    params.push(JSON.stringify(args.meta))
  }

  params.push(args.id, args.ns)
  const idParam = paramIdx++
  const nsParam = paramIdx++

  const result = await query<DataRow>(
    tx,
    `UPDATE data SET ${setClauses.join(', ')}
     WHERE id = $${idParam} AND ns = $${nsParam}
     RETURNING *`,
    params,
  )
  if (result.rows.length === 0) {
    throw new Error(`Data row not found: id=${args.id} ns=${args.ns}`)
  }
  return result.rows[0]
}

export async function deleteData(
  tx: PgPoolClient,
  args: { ns: number; id: number },
): Promise<void> {
  await query(tx, `DELETE FROM data WHERE id = $1 AND ns = $2`, [args.id, args.ns])
}

export interface FindDataArgs {
  ns: number
  collection: string
  where?: Where
  sort?: string
  limit?: number
  offset?: number
}

export async function findData(
  tx: PgPoolClient | PgPool,
  args: FindDataArgs,
): Promise<{ rows: DataRow[]; total: number }> {
  const conditions = ['data.ns = $1', 'data.collection = $2']
  const params: unknown[] = [args.ns, args.collection]
  let paramIdx = 3

  if (args.where && Object.keys(args.where).length > 0) {
    const w = whereToSQL(args.where, 'data', paramIdx)
    conditions.push(w.sql)
    params.push(...w.params)
    paramIdx += w.params.length
  }

  const whereClause = conditions.join(' AND ')
  const sortExpr = args.sort ? sanitizeSort(args.sort) : 'created DESC'
  const orderBy = `ORDER BY ${sortExpr}, data.id DESC`
  const limit = args.limit ? `LIMIT ${nextParam()}` : ''
  const offset = args.offset ? `OFFSET ${nextParam()}` : ''

  function nextParam(): string {
    return `$${paramIdx++}`
  }

  if (args.limit) params.push(args.limit)
  if (args.offset) params.push(args.offset)

  const sql = `
    SELECT data.*, count(*) OVER() AS total
    FROM data
    WHERE ${whereClause}
    ${orderBy}
    ${limit}
    ${offset}
  `

  const result = await query<DataRow & { total: string }>(tx, sql, params)
  const total = result.rows.length > 0 ? parseInt(result.rows[0].total, 10) : 0
  return {
    rows: result.rows.map(({ total: _t, ...row }) => row as unknown as DataRow),
    total,
  }
}

export async function findOneData(
  tx: PgPoolClient | PgPool,
  args: { ns: number; id: number },
): Promise<DataRow | null> {
  const result = await query<DataRow>(
    tx,
    `SELECT * FROM data WHERE id = $1 AND ns = $2`,
    [args.id, args.ns],
  )
  return result.rows[0] ?? null
}

export async function findDataCOW(
  tx: PgPoolClient | PgPool,
  args: {
    ns: number
    parent: number
    collection: string
    where?: Where
    sort?: string
    limit?: number
    offset?: number
  },
): Promise<{ rows: DataRow[]; total: number }> {
  const conditions: string[] = []
  const params: unknown[] = [args.ns, args.collection, args.parent]
  let paramIdx = 4

  if (args.where && Object.keys(args.where).length > 0) {
    const w = whereToSQL(args.where, 'combined', paramIdx)
    conditions.push(w.sql)
    params.push(...w.params)
    paramIdx += w.params.length
  }

  const whereExtra = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const orderBy = args.sort ? `ORDER BY ${sanitizeSort(args.sort)}` : 'ORDER BY created DESC'

  let limitClause = ''
  let offsetClause = ''
  if (args.limit) {
    limitClause = `LIMIT $${paramIdx++}`
    params.push(args.limit)
  }
  if (args.offset) {
    offsetClause = `OFFSET $${paramIdx++}`
    params.push(args.offset)
  }

  const sql = `
    WITH branch AS (
      SELECT d.*, true AS branched
      FROM data d
      WHERE d.ns = $1 AND d.collection = $2
    ),
    tombstones AS (
      SELECT (doc->>'_parent')::bigint AS hidden
      FROM data
      WHERE ns = $1 AND collection = '_tombstone'
    ),
    parent AS (
      SELECT d.*, false AS branched
      FROM data d
      WHERE d.ns = $3 AND d.collection = $2
        AND d.id NOT IN (
          SELECT (doc->>'_parent')::bigint
          FROM data WHERE ns = $1 AND doc->>'_parent' IS NOT NULL
        )
        AND d.id NOT IN (SELECT hidden FROM tombstones)
    ),
    combined AS (
      SELECT * FROM branch
      UNION ALL
      SELECT * FROM parent
    )
    SELECT *, count(*) OVER() AS total
    FROM combined
    ${whereExtra}
    ${orderBy}
    ${limitClause}
    ${offsetClause}
  `

  const result = await query<DataRow & { total: string; branched: boolean }>(tx, sql, params)
  const total = result.rows.length > 0 ? parseInt(result.rows[0].total, 10) : 0
  return {
    rows: result.rows.map(({ total: _t, branched: _b, ...row }) => row as unknown as DataRow),
    total,
  }
}

const PROMOTED_SORT_COLUMNS = new Set([
  'id', 'ns', 'collection', 'slug', 'status', 'locale', 'created', 'updated', 'rand',
])

function sanitizeSort(sort: string): string {
  // Handle Payload's '-field' prefix for DESC
  let dir = 'ASC'
  let field = sort.trim()

  if (field.startsWith('-')) {
    dir = 'DESC'
    field = field.slice(1)
  }

  // Parse explicit ASC/DESC suffix (overrides prefix)
  const match = field.match(/^([a-zA-Z_]+)\s*(ASC|DESC)?$/i)
  if (!match) return 'created DESC'
  const col = match[1]
  if (match[2]) dir = match[2].toUpperCase()

  // Promoted columns sort directly, JSONB fields sort via doc->>
  if (PROMOTED_SORT_COLUMNS.has(col.toLowerCase())) {
    return `${col} ${dir}`
  }
  return `doc->>'${col.replace(/'/g, "''")}' ${dir}`
}

function formatVector(embedding: number[] | null | undefined): string | null {
  if (!embedding) return null
  return `[${embedding.join(',')}]`
}

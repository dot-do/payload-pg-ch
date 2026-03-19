import type pg from 'pg'
import type { SearchRow } from '../../types.js'
import { query } from '../pg.js'

export interface InsertSearchArgs {
  ns: number
  entity: number
  collection: string
  version: number
  title?: string | null
  body?: string | null
  tags?: string[]
  locale?: string | null
  meta?: unknown
  embedding?: number[] | null
}

export async function insertSearch(
  tx: pg.PoolClient,
  args: InsertSearchArgs,
): Promise<SearchRow> {
  const result = await query<SearchRow>(
    tx,
    `INSERT INTO search (ns, entity, collection, version, title, body, tags, locale, meta, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      args.ns,
      args.entity,
      args.collection,
      args.version,
      args.title ?? null,
      args.body ?? null,
      args.tags ?? [],
      args.locale ?? null,
      args.meta ? JSON.stringify(args.meta) : null,
      args.embedding ? `[${args.embedding.join(',')}]` : null,
    ],
  )
  return result.rows[0]
}

export async function searchByEmbedding(
  pool: pg.Pool,
  args: {
    ns: number
    collection?: string
    embedding: number[]
    limit?: number
  },
): Promise<{ rows: SearchRow[]; scores: number[] }> {
  const conditions = ['ns = $1']
  const params: unknown[] = [args.ns]
  let paramIdx = 2

  if (args.collection) {
    conditions.push(`collection = $${paramIdx++}`)
    params.push(args.collection)
  }

  params.push(`[${args.embedding.join(',')}]`)
  const embeddingParam = `$${paramIdx++}`

  const limit = args.limit ?? 10
  params.push(limit)
  const limitParam = `$${paramIdx}`

  const sql = `
    SELECT *, embedding <=> ${embeddingParam}::vector AS score
    FROM search
    WHERE ${conditions.join(' AND ')}
    ORDER BY score ASC
    LIMIT ${limitParam}
  `

  const result = await query<SearchRow & { score: number }>(pool, sql, params)
  return {
    rows: result.rows.map(({ score: _s, ...row }) => row as unknown as SearchRow),
    scores: result.rows.map(r => r.score),
  }
}

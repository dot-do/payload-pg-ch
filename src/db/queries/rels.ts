import type { PgPool, PgPoolClient } from '../pg.js'
import type { RelRow, FieldSchema } from '../../types.js'
import { query } from '../pg.js'

export interface InsertRelArgs {
  ns: string
  from: number
  to: number
  path: string
  sort?: number
  meta?: unknown
}

export async function insertRel(
  tx: PgPoolClient,
  args: InsertRelArgs,
): Promise<RelRow> {
  const result = await query<RelRow>(
    tx,
    `INSERT INTO rels (ns, "from", "to", path, sort, meta)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ("from", path, "to") DO UPDATE SET sort = $5, meta = $6
     RETURNING *`,
    [args.ns, args.from, args.to, args.path, args.sort ?? 0, args.meta ? JSON.stringify(args.meta) : null],
  )
  return result.rows[0]
}

export async function deleteRelsForEntity(
  tx: PgPoolClient,
  args: { ns: string; from: number },
): Promise<void> {
  await query(tx, `DELETE FROM rels WHERE ns = $1 AND "from" = $2`, [args.ns, args.from])
}

export async function findRelsFrom(
  tx: PgPoolClient | PgPool,
  args: { from: number; path?: string; ns?: string },
): Promise<RelRow[]> {
  if (args.ns !== undefined) {
    if (args.path) {
      const result = await query<RelRow>(
        tx,
        `SELECT * FROM rels WHERE "from" = $1 AND path = $2 AND ns = $3 ORDER BY sort`,
        [args.from, args.path, args.ns],
      )
      return result.rows
    }
    const result = await query<RelRow>(
      tx,
      `SELECT * FROM rels WHERE "from" = $1 AND ns = $2 ORDER BY path, sort`,
      [args.from, args.ns],
    )
    return result.rows
  }
  if (args.path) {
    const result = await query<RelRow>(
      tx,
      `SELECT * FROM rels WHERE "from" = $1 AND path = $2 ORDER BY sort`,
      [args.from, args.path],
    )
    return result.rows
  }
  const result = await query<RelRow>(
    tx,
    `SELECT * FROM rels WHERE "from" = $1 ORDER BY path, sort`,
    [args.from],
  )
  return result.rows
}

export async function findRelsTo(
  tx: PgPoolClient | PgPool,
  args: { to: number; ns?: string },
): Promise<RelRow[]> {
  if (args.ns !== undefined) {
    const result = await query<RelRow>(
      tx,
      `SELECT * FROM rels WHERE "to" = $1 AND ns = $2`,
      [args.to, args.ns],
    )
    return result.rows
  }
  const result = await query<RelRow>(
    tx,
    `SELECT * FROM rels WHERE "to" = $1`,
    [args.to],
  )
  return result.rows
}

export interface ExtractedRel {
  to: number
  path: string
  sort: number
}

export function extractRels(
  doc: Record<string, unknown>,
  fields: FieldSchema[],
): ExtractedRel[] {
  const rels: ExtractedRel[] = []

  function walk(obj: Record<string, unknown>, fieldDefs: FieldSchema[], pathPrefix: string) {
    for (const field of fieldDefs) {
      const value = obj[field.name]
      if (value === undefined || value === null) continue

      if (field.type === 'relationship' || field.type === 'upload') {
        if (field.hasMany && Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            const target = resolveRelTarget(value[i])
            if (target !== null) {
              rels.push({
                to: target,
                path: pathPrefix ? `${pathPrefix}.${field.name}.${i}` : `${field.name}.${i}`,
                sort: i,
              })
            }
          }
        } else {
          const target = resolveRelTarget(value)
          if (target !== null) {
            rels.push({
              to: target,
              path: pathPrefix ? `${pathPrefix}.${field.name}` : field.name,
              sort: 0,
            })
          }
        }
      } else if (field.type === 'array' && Array.isArray(value) && field.fields) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i]
          if (item && typeof item === 'object') {
            const arrayPath = pathPrefix ? `${pathPrefix}.${field.name}.${i}` : `${field.name}.${i}`
            walk(item as Record<string, unknown>, field.fields, arrayPath)
          }
        }
      } else if (field.type === 'group' && typeof value === 'object' && field.fields) {
        const groupPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name
        walk(value as Record<string, unknown>, field.fields, groupPath)
      }
    }
  }

  walk(doc, fields, '')
  return rels
}

function resolveRelTarget(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as Record<string, unknown>).id
    if (typeof id === 'number') return id
  }
  return null
}

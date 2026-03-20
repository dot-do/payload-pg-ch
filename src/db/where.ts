import type { Where, WhereField } from '../types.js'

const PROMOTED_COLUMNS = new Set([
  'id', 'ns', 'collection', 'slug', 'status', 'locale', 'created', 'updated',
])

interface WhereResult {
  sql: string
  params: unknown[]
}

export function whereToSQL(
  where: Where,
  table: string = 'data',
  startParam: number = 1,
): WhereResult {
  const params: unknown[] = []
  let paramIdx = startParam

  function nextParam(value: unknown): string {
    params.push(value)
    return `$${paramIdx++}`
  }

  function compileField(field: string, op: WhereField): string {
    const col = PROMOTED_COLUMNS.has(field)
      ? `${table}."${field}"`
      : `${table}.doc->>'${field}'`

    const clauses: string[] = []

    if (op.equals !== undefined) {
      clauses.push(`${col} = ${nextParam(op.equals)}`)
    }
    if (op.not_equals !== undefined) {
      clauses.push(`${col} != ${nextParam(op.not_equals)}`)
    }
    if (op.in !== undefined) {
      if (op.in.length === 0) {
        clauses.push('1=0')
      } else {
        const placeholders = op.in.map(v => nextParam(v)).join(', ')
        clauses.push(`${col} IN (${placeholders})`)
      }
    }
    if (op.not_in !== undefined) {
      if (op.not_in.length === 0) {
        clauses.push('1=1')
      } else {
        const placeholders = op.not_in.map(v => nextParam(v)).join(', ')
        clauses.push(`${col} NOT IN (${placeholders})`)
      }
    }
    if (op.like !== undefined) {
      clauses.push(`${col} LIKE ${nextParam(op.like)}`)
    }
    if (op.contains !== undefined) {
      clauses.push(`${col} ILIKE ${nextParam(`%${op.contains}%`)}`)
    }
    if (op.greater_than !== undefined) {
      clauses.push(`${col} > ${nextParam(op.greater_than)}`)
    }
    if (op.less_than !== undefined) {
      clauses.push(`${col} < ${nextParam(op.less_than)}`)
    }
    if (op.greater_than_equal !== undefined) {
      clauses.push(`${col} >= ${nextParam(op.greater_than_equal)}`)
    }
    if (op.less_than_equal !== undefined) {
      clauses.push(`${col} <= ${nextParam(op.less_than_equal)}`)
    }
    if (op.exists !== undefined) {
      if (PROMOTED_COLUMNS.has(field)) {
        clauses.push(op.exists ? `${col} IS NOT NULL` : `${col} IS NULL`)
      } else {
        const escapedField = field.replace(/'/g, "''")
        clauses.push(
          op.exists
            ? `${table}.doc ? '${escapedField}'`
            : `NOT (${table}.doc ? '${escapedField}')`,
        )
      }
    }

    return clauses.length === 1 ? clauses[0] : `(${clauses.join(' AND ')})`
  }

  function compile(w: Where): string {
    const parts: string[] = []

    if (w.and && w.and.length > 0) {
      const andParts = w.and.map(sub => compile(sub)).filter(Boolean)
      if (andParts.length > 0) parts.push(`(${andParts.join(' AND ')})`)
    }

    if (w.or && w.or.length > 0) {
      const orParts = w.or.map(sub => compile(sub)).filter(Boolean)
      if (orParts.length > 0) parts.push(`(${orParts.join(' OR ')})`)
    }

    for (const [key, value] of Object.entries(w)) {
      if (key === 'and' || key === 'or' || value === undefined) continue
      parts.push(compileField(key, value as WhereField))
    }

    return parts.length === 0
      ? '1=1'
      : parts.length === 1
        ? parts[0]
        : `(${parts.join(' AND ')})`
  }

  const sql = compile(where)
  return { sql, params }
}

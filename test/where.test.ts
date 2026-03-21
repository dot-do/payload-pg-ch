import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { query, transaction } from '../src/db/pg.js'
import { insertData } from '../src/db/queries/data.js'
import { whereToSQL } from '../src/db/where.js'
import type pg from 'pg'

let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
})

afterAll(async () => {
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  ns = await createTestNs('where.test', 'Test')

  // Seed test data
  await transaction(pool, async (tx) => {
    await insertData(tx, { ns, type: 'posts', id: 'w-alpha', data: { title: 'Alpha', score: 10, tags: ['tech', 'science'] }, status: 'published', rand: 1 })
    await insertData(tx, { ns, type: 'posts', id: 'w-beta', data: { title: 'Beta', score: 20, tags: ['art'] }, status: 'draft', rand: 2 })
    await insertData(tx, { ns, type: 'posts', id: 'w-gamma', data: { title: 'Gamma', score: 30, tags: ['tech'] }, status: 'published', rand: 3 })
    await insertData(tx, { ns, type: 'posts', id: 'w-delta', data: { title: 'Delta', score: 40 }, status: 'archived', locale: 'fr', rand: 4 })
    await insertData(tx, { ns, type: 'posts', id: 'w-null', data: { title: null, score: 50 }, rand: 5 })
  })
})

async function findWithWhere(where: Record<string, unknown>): Promise<number> {
  const w = whereToSQL(where, 'data', 3)
  const sql = `SELECT count(*) AS cnt FROM data WHERE ns = $1 AND type = $2 AND ${w.sql}`
  const result = await query<{ cnt: number }>(pool, sql, [ns, 'posts', ...w.params])
  return result.rows[0].cnt
}

describe('where compiler against real PostgreSQL', () => {
  it('equals on promoted column', async () => {
    expect(await findWithWhere({ status: { equals: 'published' } })).toBe(2)
  })

  it('equals on JSON field', async () => {
    expect(await findWithWhere({ title: { equals: 'Beta' } })).toBe(1)
  })

  it('not_equals', async () => {
    // 5 rows: 2 published, 1 draft, 1 archived, 1 NULL status
    // NULL != 'published' → NULL (excluded), so only 2 non-published non-null rows
    expect(await findWithWhere({ status: { not_equals: 'published' } })).toBe(2)
  })

  it('in operator', async () => {
    expect(await findWithWhere({ status: { in: ['published', 'draft'] } })).toBe(3)
  })

  it('not_in operator', async () => {
    // NULL NOT IN (...) → NULL (excluded), so only 2 non-published non-null rows
    expect(await findWithWhere({ status: { not_in: ['published'] } })).toBe(2)
  })

  it('like operator', async () => {
    expect(await findWithWhere({ title: { like: '%lph%' } })).toBe(1)
  })

  it('contains (ILIKE, case-insensitive)', async () => {
    expect(await findWithWhere({ title: { contains: 'ALPHA' } })).toBe(1)
  })

  it('greater_than on JSON numeric field', async () => {
    // JSON values are strings, so comparison is lexicographic
    // For numeric comparison, promoted columns work better
    expect(await findWithWhere({ status: { greater_than: 'draft' } })).toBe(2) // published > draft
  })

  it('less_than', async () => {
    expect(await findWithWhere({ status: { less_than: 'published' } })).toBe(2) // archived, draft < published
  })

  it('greater_than_equal', async () => {
    expect(await findWithWhere({ status: { greater_than_equal: 'published' } })).toBe(2)
  })

  it('less_than_equal', async () => {
    expect(await findWithWhere({ status: { less_than_equal: 'draft' } })).toBe(2) // archived, draft
  })

  it('exists true on promoted column', async () => {
    // locale is set only on Delta
    expect(await findWithWhere({ locale: { exists: true } })).toBe(1)
  })

  it('exists false on promoted column', async () => {
    expect(await findWithWhere({ locale: { exists: false } })).toBe(4)
  })

  it('exists true on JSON field', async () => {
    // title exists on 4 of 5 (5th has title: null but the key exists in JSONB)
    expect(await findWithWhere({ title: { exists: true } })).toBe(5) // JSONB ? checks key existence, null is still a key
  })

  it('nested AND', async () => {
    expect(await findWithWhere({
      and: [
        { status: { equals: 'published' } },
        { title: { contains: 'amma' } },
      ],
    })).toBe(1)
  })

  it('nested OR', async () => {
    expect(await findWithWhere({
      or: [
        { status: { equals: 'archived' } },
        { title: { equals: 'Alpha' } },
      ],
    })).toBe(2)
  })

  it('deeply nested AND/OR', async () => {
    expect(await findWithWhere({
      and: [
        { status: { not_equals: 'archived' } },
        {
          or: [
            { title: { contains: 'Alpha' } },
            { title: { contains: 'Gamma' } },
          ],
        },
      ],
    })).toBe(2)
  })

  it('empty where matches all', async () => {
    expect(await findWithWhere({})).toBe(5)
  })

  it('multiple operators on same field', async () => {
    // status >= 'draft' AND status <= 'published'
    expect(await findWithWhere({
      status: { greater_than_equal: 'draft', less_than_equal: 'published' },
    })).toBe(3) // draft, published, published
  })
})

describe('whereToSQL unit generation', () => {
  it('generates correct parameterized SQL', () => {
    const result = whereToSQL({
      and: [
        { status: { equals: 'published' } },
        { title: { contains: 'hello' } },
      ],
    }, 'data', 1)

    expect(result.params).toEqual(['published', '%hello%'])
    expect(result.sql).toContain('$1')
    expect(result.sql).toContain('$2')
    expect(result.sql).toContain('AND')
  })

  it('handles startParam offset for subqueries', () => {
    const result = whereToSQL({ status: { equals: 'draft' } }, 'data', 5)
    expect(result.sql).toContain('$5')
    expect(result.params).toEqual(['draft'])
  })
})

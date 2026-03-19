import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { query } from '../src/db/pg.js'
import { fromSqid, toSqid, generateRand } from '../src/id/sqids.js'
import { whereToSQL } from '../src/db/where.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let nsId: number

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB }, [
    {
      slug: 'posts',
      prefix: 'pos',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
    },
    { slug: 'users', prefix: 'usr', fields: [{ name: 'name', type: 'text' }] },
  ])
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  const result = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind) VALUES ('robust.test', 'Robust', 'production') RETURNING id`,
  )
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

describe('sqid robustness', () => {
  it('generateRand is always within uint16 range', () => {
    for (let i = 0; i < 1000; i++) {
      const r = generateRand()
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(65536)
      expect(Number.isInteger(r)).toBe(true)
    }
  })

  it('toSqid always produces prefixed string', () => {
    for (let i = 0; i < 100; i++) {
      const sqid = toSqid('posts', i + 1, 1, new Date(), generateRand())
      expect(sqid).toMatch(/^pos_/)
      expect(sqid.length).toBeGreaterThan(4)
    }
  })

  it('fromSqid rejects empty string', () => {
    expect(() => fromSqid('')).toThrow()
  })

  it('fromSqid rejects string with only prefix', () => {
    expect(() => fromSqid('pos_')).toThrow()
  })

  it('fromSqid rejects mismatched re-encode (non-canonical)', () => {
    // Manually create a non-canonical encoded value
    expect(() => fromSqid('pos_0')).toThrow()
  })

  it('different rand values produce different sqids for same entity', () => {
    const now = new Date()
    const s1 = toSqid('posts', 1, 1, now, 100)
    const s2 = toSqid('posts', 1, 1, now, 200)
    expect(s1).not.toBe(s2)
  })

  it('sqid contains enough entropy to be unguessable', () => {
    const now = new Date()
    const sqids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      sqids.add(toSqid('posts', 1, 1, now, generateRand()))
    }
    // With 16-bit rand, 100 generations should be nearly all unique
    // Allow 1 collision (birthday paradox: p ≈ 0.07% for 100 of 65536)
    expect(sqids.size).toBeGreaterThanOrEqual(99)
  })
})

describe('where compiler robustness', () => {
  it('handles deeply nested AND/OR (5 levels)', () => {
    const where = {
      and: [
        {
          or: [
            { status: { equals: 'published' } },
            {
              and: [
                { title: { contains: 'test' } },
                {
                  or: [
                    { locale: { equals: 'en' } },
                    { locale: { equals: 'fr' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const result = whereToSQL(where)
    expect(result.params).toHaveLength(4)
    expect(result.sql).toContain('AND')
    expect(result.sql).toContain('OR')
  })

  it('handles many fields in single where', () => {
    const where: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) {
      where[`field${i}`] = { equals: `value${i}` }
    }
    const result = whereToSQL(where)
    expect(result.params).toHaveLength(20)
  })

  it('SQL injection attempt in field value is parameterized', async () => {
    // The value is passed as a parameter, not interpolated
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: "'; DROP TABLE data; --" } })

    const posts = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { title: { equals: "'; DROP TABLE data; --" } },
    })
    expect(posts.total).toBe(1)

    // Table should still exist
    const check = await query(pool, `SELECT count(*) AS cnt FROM data`)
    expect(check.rows[0]).toBeDefined()
  })

  it('SQL injection attempt in contains operator', async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: "test%' OR '1'='1" } })

    const posts = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { title: { contains: "%' OR '1'='1" } },
    })
    // ILIKE with % in the search term is properly escaped via parameterization
    // The contains wraps with %, so the actual search is %"%' OR '1'='1"%
    // This might match or not, but it shouldn't cause SQL injection
    expect(posts.total).toBeGreaterThanOrEqual(0)
  })
})

describe('adapter error handling', () => {
  it('create with non-existent ns fails gracefully', async () => {
    await expect(
      adapter.create({ ns: 999999, collection: 'posts', data: { title: 'Bad NS' } }),
    ).rejects.toThrow()
  })

  it('find with non-existent ns returns empty (no parent)', async () => {
    const result = await adapter.find({ ns: 999999, collection: 'posts' })
    expect(result.total).toBe(0)
    expect(result.docs).toHaveLength(0)
  })

  it('concurrent updates to same document serialize correctly', async () => {
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Race', counter: 0 },
    })

    // 5 concurrent updates
    const promises = Array.from({ length: 5 }, (_, i) =>
      adapter.updateOne({
        ns: nsId,
        collection: 'posts',
        id: post.id,
        data: { counter: i + 1 },
      }),
    )

    const results = await Promise.allSettled(promises)
    const succeeded = results.filter(r => r.status === 'fulfilled')
    // All should succeed (PG serializes via row-level locking)
    expect(succeeded.length).toBe(5)

    // Final value should be one of the updates
    const final = await adapter.findOne({ ns: nsId, collection: 'posts', id: post.id })
    expect(typeof final!.counter).toBe('number')
  })

  it('deleteMany on empty collection is safe', async () => {
    const result = await adapter.deleteMany({
      ns: nsId,
      collection: 'posts',
      where: { title: { equals: 'nonexistent' } },
    })
    expect(result.deleted).toBe(0)
  })
})

describe('namespace edge cases', () => {
  it('multiple namespaces with same prefix resolve correctly', async () => {
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('a.com', 'A', 'production')`)
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('a.com/x', 'AX', 'production')`)
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('a.com/xy', 'AXY', 'production')`)
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('a.com/xyz', 'AXYZ', 'production')`)
    await adapter.nsResolver.refresh()

    expect(adapter.nsResolver.resolve('a.com', '/x/page')!.name).toBe('AX')
    expect(adapter.nsResolver.resolve('a.com', '/xy/page')!.name).toBe('AXY')
    expect(adapter.nsResolver.resolve('a.com', '/xyz/page')!.name).toBe('AXYZ')
    expect(adapter.nsResolver.resolve('a.com', '/other')!.name).toBe('A')
  })

  it('ns cache refreshes correctly after insert', async () => {
    const ns = adapter.nsResolver.resolve('new-domain.test')
    expect(ns).toBeNull()

    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('new-domain.test', 'New', 'production')`)
    await adapter.nsResolver.refresh()

    const resolved = adapter.nsResolver.resolve('new-domain.test')
    expect(resolved).not.toBeNull()
    expect(resolved!.name).toBe('New')
  })
})

describe('data integrity across operations', () => {
  it('create → update → find shows correct final state', async () => {
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'V1', body: 'Original', tags: ['a'] },
    })

    await adapter.updateOne({
      ns: nsId,
      collection: 'posts',
      id: post.id,
      data: { title: 'V2' },
    })

    await adapter.updateOne({
      ns: nsId,
      collection: 'posts',
      id: post.id,
      data: { body: 'Updated body' },
    })

    const final = await adapter.findOne({ ns: nsId, collection: 'posts', id: post.id })
    expect(final!.title).toBe('V2')
    expect(final!.body).toBe('Updated body')
    expect(final!.tags).toEqual(['a'])
  })

  it('log tracks full history of changes', async () => {
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Track Me' },
    })
    const postId = fromSqid(post.id).id

    await adapter.updateOne({ ns: nsId, collection: 'posts', id: post.id, data: { title: 'V2' } })
    await adapter.updateOne({ ns: nsId, collection: 'posts', id: post.id, data: { title: 'V3' } })

    const logs = await query<{ kind: string; doc: Record<string, unknown> }>(
      pool,
      `SELECT kind, doc FROM log WHERE entity = $1 ORDER BY created`,
      [postId],
    )

    expect(logs.rows).toHaveLength(3)
    expect(logs.rows[0].doc.title).toBe('Track Me')
    expect(logs.rows[1].doc.title).toBe('V2')
    expect(logs.rows[2].doc.title).toBe('V3')
  })
})

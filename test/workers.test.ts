import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { query, transaction } from '../src/db/pg.js'
import { insertData } from '../src/db/queries/data.js'
import { insertSearch, searchByEmbedding } from '../src/db/queries/search.js'
import { runRetention } from '../src/workers/retention.js'
import type pg from 'pg'

let pool: pg.Pool
let nsId: number

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
})

afterAll(async () => {
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  const result = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind) VALUES ('workers.test', 'Test', 'production') RETURNING id`,
  )
  nsId = result.rows[0].id
})

describe('retention worker', () => {
  it('prunes old search transit rows', async () => {
    await transaction(pool, async (tx) => {
      await insertSearch(tx, {
        ns: nsId, entity: 1, collection: 'posts', version: 1,
        title: 'Old', body: 'Old content',
      })
    })
    // Backdate the row
    await query(pool,
      `UPDATE search SET created = now() - interval '30 days' WHERE ns = $1`,
      [nsId],
    )

    const result = await runRetention(pool, { searchRetentionDays: 7 })
    expect(result.prunedSearch).toBe(1)
  })
})

describe('search transit table', () => {
  it('inserts and queries search entries', async () => {
    await transaction(pool, async (tx) => {
      await insertSearch(tx, {
        ns: nsId,
        entity: 1,
        collection: 'posts',
        version: 1,
        title: 'Hello World',
        body: 'This is a test document about search',
        tags: ['search', 'test'],
        locale: 'en',
      })
      await insertSearch(tx, {
        ns: nsId,
        entity: 2,
        collection: 'posts',
        version: 1,
        title: 'Another Post',
        body: 'Different content entirely',
        tags: ['other'],
      })
    })

    const result = await query<{ title: string }>(
      pool,
      `SELECT title FROM search WHERE ns = $1 ORDER BY entity`,
      [nsId],
    )
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].title).toBe('Hello World')
  })
})

describe('vector search on data table', () => {
  it('finds similar documents by embedding', async () => {
    // Create documents with simple embeddings for testing
    const dim = 768
    const emb1 = new Array(dim).fill(0)
    emb1[0] = 1 // pointing in x direction
    const emb2 = new Array(dim).fill(0)
    emb2[0] = 0.9; emb2[1] = 0.1 // mostly x, little y
    const emb3 = new Array(dim).fill(0)
    emb3[1] = 1 // pointing in y direction (most different)

    await transaction(pool, async (tx) => {
      await insertData(tx, {
        ns: nsId, collection: 'posts',
        doc: { title: 'Doc A' }, rand: 1,
        embedding: emb1,
      })
      await insertData(tx, {
        ns: nsId, collection: 'posts',
        doc: { title: 'Doc B' }, rand: 2,
        embedding: emb2,
      })
      await insertData(tx, {
        ns: nsId, collection: 'posts',
        doc: { title: 'Doc C' }, rand: 3,
        embedding: emb3,
      })
    })

    // Query for vectors similar to emb1 (x-direction)
    const queryVec = new Array(dim).fill(0)
    queryVec[0] = 1

    const result = await query<{ doc: Record<string, unknown>; score: number }>(
      pool,
      `SELECT doc, embedding <=> $1::vector AS score
       FROM data WHERE ns = $2 AND embedding IS NOT NULL
       ORDER BY score ASC LIMIT 3`,
      [`[${queryVec.join(',')}]`, nsId],
    )

    expect(result.rows).toHaveLength(3)
    // Doc A should be most similar (identical direction)
    expect(result.rows[0].doc.title).toBe('Doc A')
    // Doc B should be second most similar
    expect(result.rows[1].doc.title).toBe('Doc B')
    // Doc C should be least similar (orthogonal)
    expect(result.rows[2].doc.title).toBe('Doc C')
  })
})

describe('data → search indexing pipeline simulation', () => {
  it('simulates the indexer workflow end-to-end', async () => {
    // 1. Create data row (embedding starts as NULL)
    const dataRow = await transaction(pool, async (tx) => {
      return insertData(tx, {
        ns: nsId, collection: 'posts',
        doc: { title: 'Searchable Post', body: 'Deep content about AI' },
        rand: 42,
      })
    })

    // 2. Poll for unindexed rows (like indexer does)
    const unindexed = await query<{ id: number; collection: string }>(
      pool,
      `SELECT id, collection FROM data WHERE embedding IS NULL LIMIT 1`,
    )
    expect(unindexed.rows).toHaveLength(1)
    expect(unindexed.rows[0].id).toBe(dataRow.id)

    // 3. "Compute embedding" (mock - just a unit vector)
    const embedding = new Array(768).fill(0)
    embedding[0] = 1

    // 4. Update data.embedding
    await query(pool,
      `UPDATE data SET embedding = $1::vector WHERE id = $2`,
      [`[${embedding.join(',')}]`, dataRow.id],
    )

    // 5. Write to search transit table
    await transaction(pool, async (tx) => {
      await insertSearch(tx, {
        ns: nsId,
        entity: dataRow.id,
        collection: 'posts',
        version: dataRow.id,
        title: 'Searchable Post',
        body: 'Deep content about AI',
        tags: ['ai', 'ml'],
      })
    })

    // Verify: data has embedding
    const data = await query<{ embedding: string }>(
      pool,
      `SELECT embedding FROM data WHERE id = $1`,
      [dataRow.id],
    )
    expect(data.rows[0].embedding).not.toBeNull()

    // Verify: search entry exists
    const search = await query<{ title: string; tags: string[] }>(
      pool,
      `SELECT title, tags FROM search WHERE ns = $1 AND entity = $2`,
      [nsId, dataRow.id],
    )
    expect(search.rows).toHaveLength(1)
    expect(search.rows[0].title).toBe('Searchable Post')
    expect(search.rows[0].tags).toContain('ai')

    // Verify: no more unindexed rows
    const remaining = await query(pool, `SELECT id FROM data WHERE embedding IS NULL AND ns = $1`, [nsId])
    expect(remaining.rows).toHaveLength(0)
  })
})

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { query, transaction } from '../src/db/pg.js'
import { insertData } from '../src/db/queries/data.js'
import { fromSqid } from '../src/id/sqids.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let nsId: number

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB }, [
    { slug: 'posts', prefix: 'pos', fields: [{ name: 'title', type: 'text' }] },
    { slug: 'articles', prefix: 'art', fields: [{ name: 'title', type: 'text' }] },
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
    `INSERT INTO ns (uri, name, kind) VALUES ('search.test', 'Search', 'production') RETURNING id`,
  )
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

describe('adapter.findSimilar', () => {
  it('finds documents by vector similarity', async () => {
    const dim = 768

    // Create docs with distinct embeddings
    const embX = new Array(dim).fill(0); embX[0] = 1
    const embY = new Array(dim).fill(0); embY[1] = 1
    const embXY = new Array(dim).fill(0); embXY[0] = 0.7; embXY[1] = 0.7

    await transaction(pool, async (tx) => {
      await insertData(tx, { ns: nsId, collection: 'posts', doc: { title: 'X-axis' }, rand: 1, embedding: embX })
      await insertData(tx, { ns: nsId, collection: 'posts', doc: { title: 'Y-axis' }, rand: 2, embedding: embY })
      await insertData(tx, { ns: nsId, collection: 'posts', doc: { title: 'XY-diagonal' }, rand: 3, embedding: embXY })
    })

    // Search for X-direction
    const queryVec = new Array(dim).fill(0); queryVec[0] = 1
    const results = await adapter.findSimilar({
      ns: nsId,
      embedding: queryVec,
      limit: 3,
    })

    expect(results.docs).toHaveLength(3)
    expect(results.scores).toHaveLength(3)
    // Scores should be ascending (lower = more similar for cosine distance)
    expect(results.scores[0]).toBeLessThanOrEqual(results.scores[1])
  })

  it('filters by collection', async () => {
    const dim = 768
    const emb = new Array(dim).fill(0); emb[0] = 1

    await transaction(pool, async (tx) => {
      await insertData(tx, { ns: nsId, collection: 'posts', doc: { title: 'Post' }, rand: 1, embedding: emb })
      await insertData(tx, { ns: nsId, collection: 'articles', doc: { title: 'Article' }, rand: 2, embedding: emb })
    })

    const results = await adapter.findSimilar({
      ns: nsId,
      collection: 'posts',
      embedding: emb,
      limit: 10,
    })

    expect(results.docs).toHaveLength(1)
  })

  it('returns empty for no matching embeddings', async () => {
    // Create doc without embedding
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'No Vector' } })

    const queryVec = new Array(768).fill(0); queryVec[0] = 1
    const results = await adapter.findSimilar({
      ns: nsId,
      embedding: queryVec,
      limit: 10,
    })

    expect(results.docs).toHaveLength(0)
  })

  it('respects limit', async () => {
    const dim = 768
    const emb = new Array(dim).fill(0); emb[0] = 1

    await transaction(pool, async (tx) => {
      for (let i = 0; i < 5; i++) {
        const e = new Array(dim).fill(0); e[0] = 1; e[1] = i * 0.1
        await insertData(tx, { ns: nsId, collection: 'posts', doc: { title: `Doc ${i}` }, rand: i, embedding: e })
      }
    })

    const results = await adapter.findSimilar({
      ns: nsId,
      embedding: emb,
      limit: 2,
    })

    expect(results.docs).toHaveLength(2)
  })
})

describe('adapter.createBranch and mergeBranch', () => {
  it('createBranch inherits parent config', async () => {
    // Set parent repo info
    await query(pool, `UPDATE ns SET repo = 'org/repo', root = '/content' WHERE id = $1`, [nsId])
    await adapter.nsResolver.refresh()

    const branch = await adapter.createBranch({
      parent: nsId,
      uri: 'search.test/pr/1',
      branch: 'feat/search',
      kind: 'preview',
      pr: 1,
    })

    expect(branch.parent).toBe(nsId)
    expect(branch.repo).toBe('org/repo')
    expect(branch.root).toBe('/content')
    expect(branch.kind).toBe('preview')
  })

  it('full branch lifecycle: create → edit → merge → verify', async () => {
    // Create content in parent
    const p1 = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Stable' } })
    const p2 = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Will Change' } })

    // Create branch
    const branch = await adapter.createBranch({
      parent: nsId,
      uri: 'search.test/pr/lifecycle',
      branch: 'feat/lifecycle',
    })
    await adapter.nsResolver.refresh()

    // Edit in branch
    await adapter.updateOne({
      ns: branch.id,
      collection: 'posts',
      id: p2.id,
      data: { title: 'Changed!' },
    })

    // Verify branch view
    const branchPosts = await adapter.find({ ns: branch.id, collection: 'posts' })
    expect(branchPosts.total).toBe(2)
    const branchTitles = branchPosts.docs.map(d => d.title).sort()
    expect(branchTitles).toContain('Changed!')
    expect(branchTitles).toContain('Stable')

    // Parent unchanged
    const parentPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(parentPosts.docs.map(d => d.title).sort()).toContain('Will Change')

    // Merge
    const result = await adapter.mergeBranch(branch.id)
    expect(result.merged).toBeGreaterThan(0)

    // Parent now has the change
    const afterMerge = await adapter.find({ ns: nsId, collection: 'posts' })
    const afterTitles = afterMerge.docs.map(d => d.title).sort()
    expect(afterTitles).toContain('Changed!')
    expect(afterTitles).toContain('Stable')
    expect(afterTitles).not.toContain('Will Change')
  })
})

describe('adapter collection tier', () => {
  it('tier returns pg for standard collections', () => {
    expect(adapter.tier('posts')).toBe('pg')
    expect(adapter.tier('users')).toBe('pg')
    expect(adapter.tier('media')).toBe('pg')
    expect(adapter.tier('custom')).toBe('pg')
  })

  it('tier returns ch for analytics collections', () => {
    expect(adapter.tier('events')).toBe('ch')
    expect(adapter.tier('versions')).toBe('ch')
    expect(adapter.tier('search')).toBe('ch')
  })
})

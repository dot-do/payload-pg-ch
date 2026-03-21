import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { query, transaction } from '../src/db/pg.js'
import { insertData } from '../src/db/queries/data.js'
import { fromSqid } from '../src/id/sqids.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB, ns: 'search.test' }, [
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
  ns = await createTestNs('search.test', 'Search')
  await adapter.nsResolver.refresh()
})

describe('adapter.findSimilar', () => {
  it('finds documents by vector similarity', async () => {
    const dim = 768

    const embX = new Array(dim).fill(0); embX[0] = 1
    const embY = new Array(dim).fill(0); embY[1] = 1
    const embXY = new Array(dim).fill(0); embXY[0] = 0.7; embXY[1] = 0.7

    await transaction(pool, async (tx) => {
      await insertData(tx, { ns, type: 'posts', id: 'x-axis', data: { title: 'X-axis' }, rand: 1, embedding: embX })
      await insertData(tx, { ns, type: 'posts', id: 'y-axis', data: { title: 'Y-axis' }, rand: 2, embedding: embY })
      await insertData(tx, { ns, type: 'posts', id: 'xy-diag', data: { title: 'XY-diagonal' }, rand: 3, embedding: embXY })
    })

    const queryVec = new Array(dim).fill(0); queryVec[0] = 1
    const results = await adapter.findSimilar({
      ns,
      embedding: queryVec,
      limit: 3,
    })

    expect(results.docs).toHaveLength(3)
    expect(results.scores).toHaveLength(3)
    expect(results.scores[0]).toBeLessThanOrEqual(results.scores[1])
  })

  it('filters by type', async () => {
    const dim = 768
    const emb = new Array(dim).fill(0); emb[0] = 1

    await transaction(pool, async (tx) => {
      await insertData(tx, { ns, type: 'posts', id: 'post-emb', data: { title: 'Post' }, rand: 1, embedding: emb })
      await insertData(tx, { ns, type: 'articles', id: 'art-emb', data: { title: 'Article' }, rand: 2, embedding: emb })
    })

    const results = await adapter.findSimilar({
      ns,
      type: 'posts',
      embedding: emb,
      limit: 10,
    })

    expect(results.docs).toHaveLength(1)
  })

  it('returns empty for no matching embeddings', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'No Vector' } })

    const queryVec = new Array(768).fill(0); queryVec[0] = 1
    const results = await adapter.findSimilar({
      ns,
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
        await insertData(tx, { ns, type: 'posts', id: `limit-doc-${i}`, data: { title: `Doc ${i}` }, rand: i, embedding: e })
      }
    })

    const results = await adapter.findSimilar({
      ns,
      embedding: emb,
      limit: 2,
    })

    expect(results.docs).toHaveLength(2)
  })
})

describe('adapter.createBranch and mergeBranch', () => {
  it('full branch lifecycle: create -> edit -> merge -> verify', async () => {
    const p1 = await adapter.create({ ns, type: 'posts', data: { title: 'Stable' } })
    const p2 = await adapter.create({ ns, type: 'posts', data: { title: 'Will Change' } })

    const branch = await adapter.createBranch({
      parentNs: ns,
      ns: 'search.test/pr/lifecycle',
      branch: 'feat/lifecycle',
    })
    await adapter.nsResolver.refresh()

    await adapter.updateOne({
      ns: branch.ns,
      type: 'posts',
      id: p2.id,
      data: { title: 'Changed!' },
    })

    const branchPosts = await adapter.find({ ns: branch.ns, type: 'posts' })
    expect(branchPosts.total).toBe(2)
    const branchTitles = branchPosts.docs.map(d => d.title).sort()
    expect(branchTitles).toContain('Changed!')
    expect(branchTitles).toContain('Stable')

    const parentPosts = await adapter.find({ ns, type: 'posts' })
    expect(parentPosts.docs.map(d => d.title).sort()).toContain('Will Change')

    const result = await adapter.mergeBranch(branch.ns)
    expect(result.merged).toBeGreaterThan(0)

    const afterMerge = await adapter.find({ ns, type: 'posts' })
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

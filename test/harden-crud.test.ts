import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()

  adapter = new DocumentAdapter({ postgres: TEST_DB, ns: 'harden.test' }, [
    {
      slug: 'posts',
      prefix: 'pos',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'body', type: 'textarea' },
      ],
    },
    {
      slug: 'users',
      prefix: 'usr',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'email', type: 'email' },
      ],
    },
  ])
})

afterAll(async () => {
  await adapter.destroy()
  await teardownTestPool()
})

beforeEach(async () => {
  await cleanupTestData()
  ns = await createTestNs('harden.test', 'Harden')
  await adapter.nsResolver.refresh()
})

describe('where: empty IN / NOT IN arrays', () => {
  beforeEach(async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'A' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'B' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'C' } })
  })

  it('empty in array returns no results (not SQL error)', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: { title: { in: [] } },
    })
    expect(result.total).toBe(0)
    expect(result.docs).toHaveLength(0)
  })

  it('empty not_in array returns all results', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: { title: { not_in: [] } },
    })
    expect(result.total).toBe(3)
    expect(result.docs).toHaveLength(3)
  })
})

describe('deleteMany in branch', () => {
  let branchNs: string

  beforeEach(async () => {
    const branch = await adapter.createBranch({
      parentNs: ns,
      ns: 'harden.test/pr/99',
      branch: 'feat/harden',
      kind: 'preview',
      ttl: '7 days',
      pr: 99,
    })
    branchNs = branch.ns
    await adapter.nsResolver.refresh()
  })

  it('branch-created doc is actually removed (not tombstoned)', async () => {
    const branchDoc = await adapter.create({
      ns: branchNs,
      type: 'posts',
      data: { title: 'Branch Native' },
    })

    await adapter.deleteMany({
      ns: branchNs,
      type: 'posts',
      where: { title: { equals: 'Branch Native' } },
    })

    const found = await adapter.find({ ns: branchNs, type: 'posts' })
    expect(found.total).toBe(0)

    const seq = fromSqid(branchDoc.id).seq
    const rows = await query(
      pool,
      `SELECT seq FROM data WHERE seq = $1 AND ns = $2`,
      [seq, branchNs],
    )
    expect(rows.rows).toHaveLength(0)

    const tombstones = await query(
      pool,
      `SELECT seq FROM data WHERE ns = $1 AND type = '_tombstone'`,
      [branchNs],
    )
    expect(tombstones.rows).toHaveLength(0)
  })

  it('inherited parent doc gets tombstone', async () => {
    await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Parent Doc' },
    })

    await adapter.deleteMany({
      ns: branchNs,
      type: 'posts',
      where: { title: { equals: 'Parent Doc' } },
    })

    const branchPosts = await adapter.find({ ns: branchNs, type: 'posts' })
    expect(branchPosts.total).toBe(0)

    const parentPosts = await adapter.find({ ns, type: 'posts' })
    expect(parentPosts.total).toBe(1)

    const tombstones = await query(
      pool,
      `SELECT data FROM data WHERE ns = $1 AND type = '_tombstone'`,
      [branchNs],
    )
    expect(tombstones.rows).toHaveLength(1)
  })
})

describe('find with where + sort combined', () => {
  beforeEach(async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'Banana', status: 'published' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Apple', status: 'published' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Cherry', status: 'draft' } })
  })

  it('returns filtered and sorted results', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: { status: { equals: 'published' } },
      sort: 'created ASC',
    })
    expect(result.total).toBe(2)
    expect(result.docs).toHaveLength(2)
    expect(result.docs[0].title).toBe('Banana')
    expect(result.docs[1].title).toBe('Apple')
  })
})

describe('sort with SQL injection falls back to default', () => {
  it('ignores malicious sort input', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'Safe' } })

    const result = await adapter.find({
      ns,
      type: 'posts',
      sort: 'created; DROP TABLE data; --',
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Safe')
  })
})

describe('findOne with neither id nor where returns null', () => {
  it('returns null', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'Exists' } })

    const result = await adapter.findOne({
      ns,
      type: 'posts',
    })
    expect(result).toBeNull()
  })
})

describe('updateOne in branch', () => {
  let branchNs: string

  beforeEach(async () => {
    const branch = await adapter.createBranch({
      parentNs: ns,
      ns: 'harden.test/pr/100',
      branch: 'feat/update-test',
      kind: 'preview',
      ttl: '7 days',
      pr: 100,
    })
    branchNs = branch.ns
    await adapter.nsResolver.refresh()
  })

  it('second update does not re-fork', async () => {
    const parentPost = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Original' },
    })

    await adapter.updateOne({
      ns: branchNs,
      type: 'posts',
      id: parentPost.id,
      data: { title: 'V2' },
    })

    const afterFirst = await query<{ cnt: string }>(
      pool,
      `SELECT count(*) AS cnt FROM data WHERE ns = $1 AND type = 'posts'`,
      [branchNs],
    )
    const countAfterFirst = parseInt(afterFirst.rows[0].cnt, 10)

    await adapter.updateOne({
      ns: branchNs,
      type: 'posts',
      id: parentPost.id,
      data: { title: 'V3' },
    })

    const afterSecond = await query<{ cnt: string }>(
      pool,
      `SELECT count(*) AS cnt FROM data WHERE ns = $1 AND type = 'posts'`,
      [branchNs],
    )
    const countAfterSecond = parseInt(afterSecond.rows[0].cnt, 10)

    expect(countAfterSecond).toBe(countAfterFirst)

    const found = await adapter.findOne({
      ns: branchNs,
      type: 'posts',
      id: parentPost.id,
    })
    expect(found).not.toBeNull()
    expect(found!.title).toBe('V3')
  })

  it('returned doc has no _parent', async () => {
    const parentPost = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Original' },
    })

    const updated = await adapter.updateOne({
      ns: branchNs,
      type: 'posts',
      id: parentPost.id,
      data: { title: 'Branched' },
    })

    const doc = updated.doc as Record<string, unknown>
    expect(doc._parent).toBeUndefined()
    expect(doc.title).toBe('Branched')
  })
})

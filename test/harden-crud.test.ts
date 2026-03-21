import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
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

  const result = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind, branch) VALUES ('harden.test', 'Harden', 'production', 'main') RETURNING id`,
  )
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

describe('where: empty IN / NOT IN arrays', () => {
  beforeEach(async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'A' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'B' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'C' } })
  })

  it('empty in array returns no results (not SQL error)', async () => {
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { title: { in: [] } },
    })
    expect(result.total).toBe(0)
    expect(result.docs).toHaveLength(0)
  })

  it('empty not_in array returns all results', async () => {
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { title: { not_in: [] } },
    })
    expect(result.total).toBe(3)
    expect(result.docs).toHaveLength(3)
  })
})

describe('deleteMany in branch', () => {
  let branchNsId: number

  beforeEach(async () => {
    const branchNs = await adapter.createBranch({
      parent: nsId,
      uri: 'harden.test/pr/99',
      branch: 'feat/harden',
      kind: 'preview',
      ttl: '7 days',
      pr: 99,
    })
    branchNsId = branchNs.id
    await adapter.nsResolver.refresh()
  })

  it('branch-created doc is actually removed (not tombstoned)', async () => {
    // Create doc directly in branch (no parent)
    const branchDoc = await adapter.create({
      ns: branchNsId,
      collection: 'posts',
      data: { title: 'Branch Native' },
    })

    await adapter.deleteMany({
      ns: branchNsId,
      collection: 'posts',
      where: { title: { equals: 'Branch Native' } },
    })

    // Should not be visible
    const found = await adapter.find({ ns: branchNsId, collection: 'posts' })
    expect(found.total).toBe(0)

    // The row should be actually deleted (not a tombstone)
    const intId = fromSqid(branchDoc.id).id
    const rows = await query(
      pool,
      `SELECT id FROM data WHERE id = $1 AND ns = $2`,
      [intId, branchNsId],
    )
    expect(rows.rows).toHaveLength(0)

    // No tombstone should have been created for a branch-native doc
    const tombstones = await query(
      pool,
      `SELECT id FROM data WHERE ns = $1 AND collection = '_tombstone'`,
      [branchNsId],
    )
    expect(tombstones.rows).toHaveLength(0)
  })

  it('inherited parent doc gets tombstone', async () => {
    // Create doc in parent
    await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Parent Doc' },
    })

    // Delete from branch scope
    await adapter.deleteMany({
      ns: branchNsId,
      collection: 'posts',
      where: { title: { equals: 'Parent Doc' } },
    })

    // Branch should not see it
    const branchPosts = await adapter.find({ ns: branchNsId, collection: 'posts' })
    expect(branchPosts.total).toBe(0)

    // Parent still has it
    const parentPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(parentPosts.total).toBe(1)

    // A tombstone should exist
    const tombstones = await query(
      pool,
      `SELECT doc FROM data WHERE ns = $1 AND collection = '_tombstone'`,
      [branchNsId],
    )
    expect(tombstones.rows).toHaveLength(1)
  })
})

describe('find with where + sort combined', () => {
  beforeEach(async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Banana', status: 'published' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Apple', status: 'published' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Cherry', status: 'draft' } })
  })

  it('returns filtered and sorted results', async () => {
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { status: { equals: 'published' } },
      sort: 'created ASC',
    })
    expect(result.total).toBe(2)
    expect(result.docs).toHaveLength(2)
    // First created should come first with ASC sort
    expect(result.docs[0].title).toBe('Banana')
    expect(result.docs[1].title).toBe('Apple')
  })
})

describe('sort with SQL injection falls back to default', () => {
  it('ignores malicious sort input', async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Safe' } })

    // This should not cause an error - sanitizeSort should catch it
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
      sort: 'created; DROP TABLE data; --',
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Safe')
  })
})

describe('findOne with neither id nor where returns null', () => {
  it('returns null', async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Exists' } })

    const result = await adapter.findOne({
      ns: nsId,
      collection: 'posts',
    })
    expect(result).toBeNull()
  })
})

describe('updateOne in branch', () => {
  let branchNsId: number

  beforeEach(async () => {
    const branchNs = await adapter.createBranch({
      parent: nsId,
      uri: 'harden.test/pr/100',
      branch: 'feat/update-test',
      kind: 'preview',
      ttl: '7 days',
      pr: 100,
    })
    branchNsId = branchNs.id
    await adapter.nsResolver.refresh()
  })

  it('second update does not re-fork', async () => {
    const parentPost = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Original' },
    })

    // First update in branch - forks from parent
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: parentPost.id,
      data: { title: 'V2' },
    })

    // Count branch rows after first fork
    const afterFirst = await query<{ cnt: string }>(
      pool,
      `SELECT count(*) AS cnt FROM data WHERE ns = $1 AND collection = 'posts'`,
      [branchNsId],
    )
    const countAfterFirst = parseInt(afterFirst.rows[0].cnt, 10)

    // Second update in branch - should NOT create another fork row
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: parentPost.id,
      data: { title: 'V3' },
    })

    const afterSecond = await query<{ cnt: string }>(
      pool,
      `SELECT count(*) AS cnt FROM data WHERE ns = $1 AND collection = 'posts'`,
      [branchNsId],
    )
    const countAfterSecond = parseInt(afterSecond.rows[0].cnt, 10)

    expect(countAfterSecond).toBe(countAfterFirst)

    // Verify it actually updated
    const found = await adapter.findOne({
      ns: branchNsId,
      collection: 'posts',
      id: parentPost.id,
    })
    expect(found).not.toBeNull()
    expect(found!.title).toBe('V3')
  })

  it('returned doc has no _parent', async () => {
    const parentPost = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Original' },
    })

    const updated = await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: parentPost.id,
      data: { title: 'Branched' },
    })

    const doc = updated.doc as Record<string, unknown>
    expect(doc._parent).toBeUndefined()
    expect(doc.title).toBe('Branched')
  })
})

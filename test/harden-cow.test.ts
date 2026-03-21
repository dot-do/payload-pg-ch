import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let parentNsId: number
let branchNsId: number

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()
  adapter = new DocumentAdapter({ postgres: TEST_DB }, [
    {
      slug: 'posts',
      prefix: 'pos',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'slug', type: 'text' },
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

  // Create parent (production) namespace
  const parentResult = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind, branch, repo, root)
     VALUES ('cow.test', 'Production', 'production', 'main', 'org/repo', '/')
     RETURNING id`,
  )
  parentNsId = parentResult.rows[0].id

  // Create branch namespace
  const branchResult = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind, branch, parent, repo, root)
     VALUES ('cow.test/pr/1', 'Branch', 'preview', 'feat/cow', $1, 'org/repo', '/')
     RETURNING id`,
    [parentNsId],
  )
  branchNsId = branchResult.rows[0].id

  await adapter.nsResolver.refresh()
})

describe('findOne tombstone checks', () => {
  it('findOne by ID for tombstoned doc returns null in branch', async () => {
    // Create a doc in parent
    const created = await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'To Be Deleted' },
    })

    // Delete it in the branch (creates tombstone)
    await adapter.deleteMany({
      ns: branchNsId,
      collection: 'posts',
      where: { title: { equals: 'To Be Deleted' } },
    })

    // findOne by ID in branch should return null (tombstoned)
    const found = await adapter.findOne({
      ns: branchNsId,
      collection: 'posts',
      id: created.id,
    })
    expect(found).toBeNull()
  })

  it('findOne by where for tombstoned doc returns null in branch', async () => {
    // Create a doc in parent
    await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'Tombstoned By Where', slug: 'tombstoned' },
    })

    // Delete in branch
    await adapter.deleteMany({
      ns: branchNsId,
      collection: 'posts',
      where: { slug: { equals: 'tombstoned' } },
    })

    // findOne by where should not find it
    const found = await adapter.findOne({
      ns: branchNsId,
      collection: 'posts',
      where: { slug: { equals: 'tombstoned' } },
    })
    expect(found).toBeNull()
  })
})

describe('double-merge guard', () => {
  it('double-merge throws error', async () => {
    // Create a doc in parent, fork in branch, merge once
    await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'Merge Test' },
    })

    // Merge branch
    await adapter.mergeBranch(branchNsId)
    await adapter.nsResolver.refresh()

    // Second merge should throw
    await expect(adapter.mergeBranch(branchNsId)).rejects.toThrow('Branch already merged')
  })
})

describe('COW find with pagination', () => {
  it('find with limit/offset pagination across branch + parent', async () => {
    // Create 5 docs in parent
    for (let i = 1; i <= 5; i++) {
      await adapter.create({
        ns: parentNsId,
        collection: 'posts',
        data: { title: `Parent ${i}` },
      })
    }

    // Create 3 docs directly in branch (new, not forked)
    for (let i = 1; i <= 3; i++) {
      await adapter.create({
        ns: branchNsId,
        collection: 'posts',
        data: { title: `Branch ${i}` },
      })
    }

    // Total should be 8 (5 parent + 3 branch)
    const all = await adapter.find({
      ns: branchNsId,
      collection: 'posts',
    })
    expect(all.total).toBe(8)

    // Paginate: first page of 3
    const page1 = await adapter.find({
      ns: branchNsId,
      collection: 'posts',
      limit: 3,
      offset: 0,
      sort: 'created ASC',
    })
    expect(page1.docs).toHaveLength(3)

    // Second page of 3
    const page2 = await adapter.find({
      ns: branchNsId,
      collection: 'posts',
      limit: 3,
      offset: 3,
      sort: 'created ASC',
    })
    expect(page2.docs).toHaveLength(3)

    // Third page gets remaining 2
    const page3 = await adapter.find({
      ns: branchNsId,
      collection: 'posts',
      limit: 3,
      offset: 6,
      sort: 'created ASC',
    })
    expect(page3.docs).toHaveLength(2)

    // No duplicates across pages
    const allTitles = [...page1.docs, ...page2.docs, ...page3.docs].map(d => d.title)
    expect(new Set(allTitles).size).toBe(8)
  })
})

describe('update forked doc preserves _parent through merge', () => {
  it('update forked doc multiple times - _parent preserved through merge', async () => {
    // Create doc in parent
    const created = await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'Original', body: 'Original body' },
    })
    const { id: parentDocId } = fromSqid(created.id)

    // Update once in branch (triggers COW fork)
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: created.id,
      data: { title: 'Updated Once' },
    })

    // Update again in branch
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: created.id,
      data: { title: 'Updated Twice', body: 'New body' },
    })

    // Verify the forked doc still has _parent in meta column
    const forkedRows = await query<{ meta: Record<string, unknown> }>(
      pool,
      `SELECT meta FROM data WHERE ns = $1 AND collection = 'posts'`,
      [branchNsId],
    )
    expect(forkedRows.rows).toHaveLength(1)
    expect((forkedRows.rows[0].meta as Record<string, unknown>)._parent).toBe(parentDocId)

    // Merge should write back to parent
    const result = await adapter.mergeBranch(branchNsId)
    expect(result.merged).toBe(1)

    // Parent doc should have final values
    const parentDoc = await adapter.findOne({
      ns: parentNsId,
      collection: 'posts',
      id: created.id,
    })
    expect(parentDoc).not.toBeNull()
    expect(parentDoc!.title).toBe('Updated Twice')
    expect(parentDoc!.body).toBe('New body')
  })
})

describe('parent doc changed after branch - merge overwrites', () => {
  it('last-write-wins on merge', async () => {
    // Create doc in parent
    const created = await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'V1', body: 'Parent body' },
    })

    // Update in branch (fork)
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: created.id,
      data: { title: 'Branch Version' },
    })

    // Update in parent directly (simulates concurrent edit)
    await adapter.updateOne({
      ns: parentNsId,
      collection: 'posts',
      id: created.id,
      data: { title: 'Parent V2', body: 'Parent updated body' },
    })

    // Merge - branch should overwrite parent (last-write-wins)
    await adapter.mergeBranch(branchNsId)

    const final = await adapter.findOne({
      ns: parentNsId,
      collection: 'posts',
      id: created.id,
    })
    expect(final).not.toBeNull()
    expect(final!.title).toBe('Branch Version')
  })
})

describe('delete parent doc in branch, create new with same slug', () => {
  it('only new doc visible after delete + recreate in branch', async () => {
    // Create doc in parent with a slug
    await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'Original', slug: 'unique-slug' },
    })

    // Delete it in branch
    await adapter.deleteMany({
      ns: branchNsId,
      collection: 'posts',
      where: { slug: { equals: 'unique-slug' } },
    })

    // Create a new doc in branch with same slug
    await adapter.create({
      ns: branchNsId,
      collection: 'posts',
      data: { title: 'Replacement', slug: 'unique-slug' },
    })

    // Find in branch should only see the new one
    const results = await adapter.find({
      ns: branchNsId,
      collection: 'posts',
      where: { slug: { equals: 'unique-slug' } },
    })
    expect(results.total).toBe(1)
    expect(results.docs[0].title).toBe('Replacement')
  })
})

describe('find in branch with where matches both branch and parent docs', () => {
  it('returns docs from both branch and parent matching where', async () => {
    // Create docs in parent with status published
    await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'Parent Published', status: 'published' },
    })
    await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'Parent Draft', status: 'draft' },
    })

    // Create a published doc in branch
    await adapter.create({
      ns: branchNsId,
      collection: 'posts',
      data: { title: 'Branch Published', status: 'published' },
    })

    // Find published in branch - should see parent published + branch published
    const results = await adapter.find({
      ns: branchNsId,
      collection: 'posts',
      where: { status: { equals: 'published' } },
    })
    expect(results.total).toBe(2)
    const titles = results.docs.map(d => d.title)
    expect(titles).toContain('Parent Published')
    expect(titles).toContain('Branch Published')
  })
})

describe('find in branch: mix of inherited/forked, none with _parent', () => {
  it('returned docs never expose _parent field', async () => {
    // Create docs in parent
    const p1 = await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'Inherited' },
    })
    const p2 = await adapter.create({
      ns: parentNsId,
      collection: 'posts',
      data: { title: 'To Be Forked' },
    })

    // Fork p2 in branch by updating it
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: p2.id,
      data: { title: 'Forked' },
    })

    // Create a new doc in branch
    await adapter.create({
      ns: branchNsId,
      collection: 'posts',
      data: { title: 'Branch Only' },
    })

    // Find all in branch
    const results = await adapter.find({
      ns: branchNsId,
      collection: 'posts',
    })
    expect(results.total).toBe(3)

    // No doc should expose _parent
    for (const doc of results.docs) {
      expect(doc).not.toHaveProperty('_parent')
    }

    // Verify the forked doc shows updated title
    const titles = results.docs.map(d => d.title)
    expect(titles).toContain('Inherited')
    expect(titles).toContain('Forked')
    expect(titles).toContain('Branch Only')
    expect(titles).not.toContain('To Be Forked')
  })
})

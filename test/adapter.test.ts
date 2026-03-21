import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid, toSqid, generateRand } from '../src/id/sqids.js'
import { transaction, query } from '../src/db/pg.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()

  adapter = new DocumentAdapter({ postgres: TEST_DB, ns: 'test.local' }, [
    {
      slug: 'posts',
      prefix: 'pos',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'body', type: 'textarea' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
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
    {
      slug: 'categories',
      prefix: 'cat',
      fields: [
        { name: 'title', type: 'text' },
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

  // Create a production namespace
  ns = await createTestNs('test.local', 'Test')
  await adapter.nsResolver.refresh()
})

describe('CRUD lifecycle', () => {
  it('creates a document and returns a sqid', async () => {
    const result = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Hello World', body: 'Content here' },
    })

    expect(result.id).toMatch(/^pos_/)
    expect(result.doc).toEqual({ title: 'Hello World', body: 'Content here' })

    // Verify sqid decodes correctly
    const decoded = fromSqid(result.id)
    expect(decoded.prefix).toBe('pos')
    expect(decoded.seq).toBeGreaterThan(0)
  })

  it('finds documents by type', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'Post 1' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Post 2' } })
    await adapter.create({ ns, type: 'users', data: { name: 'User 1' } })

    const posts = await adapter.find({ ns, type: 'posts' })
    expect(posts.total).toBe(2)
    expect(posts.docs).toHaveLength(2)
    expect(posts.docs[0].id).toMatch(/^pos_/)
  })

  it('finds one document by sqid', async () => {
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Find Me' },
    })

    const found = await adapter.findOne({
      ns,
      type: 'posts',
      id: created.id,
    })

    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.title).toBe('Find Me')
  })

  it('updates a document', async () => {
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Original', body: 'Original body' },
    })

    const updated = await adapter.updateOne({
      ns,
      type: 'posts',
      id: created.id,
      data: { title: 'Updated' },
    })

    expect(updated.id).toBe(created.id)
    const doc = updated.doc as Record<string, unknown>
    expect(doc.title).toBe('Updated')
    expect(doc.body).toBe('Original body') // Merged, not replaced
  })

  it('deletes documents', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'Delete Me', status: 'draft' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Keep Me', status: 'published' } })

    await adapter.deleteMany({
      ns,
      type: 'posts',
      where: { status: { equals: 'draft' } },
    })

    const remaining = await adapter.find({ ns, type: 'posts' })
    expect(remaining.total).toBe(1)
    expect(remaining.docs[0].title).toBe('Keep Me')
  })
})

describe('sqid encoding through full lifecycle', () => {
  it('sqids are stable across find/findOne', async () => {
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Stable ID' },
    })

    const found = await adapter.findOne({ ns, type: 'posts', id: created.id })
    expect(found!.id).toBe(created.id)

    const listed = await adapter.find({ ns, type: 'posts' })
    expect(listed.docs[0].id).toBe(created.id)
  })

  it('different types produce different prefixes', async () => {
    const post = await adapter.create({ ns, type: 'posts', data: { title: 'Post' } })
    const user = await adapter.create({ ns, type: 'users', data: { name: 'User' } })

    expect(post.id).toMatch(/^pos_/)
    expect(user.id).toMatch(/^usr_/)
  })

  it('sqid round-trips through fromSqid', async () => {
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Roundtrip' },
    })

    const decoded = fromSqid(created.id)
    expect(decoded.prefix).toBe('pos')
    expect(decoded.nsHash).toBeGreaterThanOrEqual(0)
    expect(decoded.seq).toBeGreaterThan(0)
    expect(decoded.epoch).toBeGreaterThan(0)
  })
})

describe('relationships', () => {
  it('creates and traverses relationships via extractRels', async () => {
    const user = await adapter.create({
      ns,
      type: 'users',
      data: { name: 'Author' },
    })
    const userId = fromSqid(user.id).seq

    const cat1 = await adapter.create({
      ns,
      type: 'categories',
      data: { title: 'Tech' },
    })
    const cat1Id = fromSqid(cat1.id).seq

    const cat2 = await adapter.create({
      ns,
      type: 'categories',
      data: { title: 'Science' },
    })
    const cat2Id = fromSqid(cat2.id).seq

    // Create post with relationships (integer seq IDs in doc, extractRels resolves them)
    const post = await adapter.create({
      ns,
      type: 'posts',
      data: {
        title: 'Post with rels',
        author: userId,
        categories: [cat1Id, cat2Id],
      },
    })

    // Verify rels were created in the rels table
    const relsResult = await query<{ from: number; to: number; path: string; sort: number }>(
      pool,
      `SELECT "from", "to", path, sort FROM rels WHERE ns = $1 ORDER BY path, sort`,
      [ns],
    )

    expect(relsResult.rows.length).toBe(3) // author + 2 categories
    expect(relsResult.rows.find(r => r.path === 'author')?.to).toBe(userId)
    expect(relsResult.rows.filter(r => r.path.startsWith('categories'))).toHaveLength(2)
  })

  it('relate() and related() work with sqids', async () => {
    const user = await adapter.create({ ns, type: 'users', data: { name: 'Author' } })
    const post = await adapter.create({ ns, type: 'posts', data: { title: 'Post' } })

    await adapter.relate({ ns, from: post.id, to: user.id, path: 'reviewer' })

    const related = await adapter.related({ id: post.id, path: 'reviewer', direction: 'from' })
    expect(related).toHaveLength(1)
    expect(related[0].path).toBe('reviewer')
  })

  it('rebuilds rels on update', async () => {
    const user1 = await adapter.create({ ns, type: 'users', data: { name: 'Author 1' } })
    const user2 = await adapter.create({ ns, type: 'users', data: { name: 'Author 2' } })
    const user1Id = fromSqid(user1.id).seq
    const user2Id = fromSqid(user2.id).seq

    const post = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Post', author: user1Id },
    })

    // Update to different author
    await adapter.updateOne({
      ns,
      type: 'posts',
      id: post.id,
      data: { author: user2Id },
    })

    const postSeq = fromSqid(post.id).seq
    const relsResult = await query<{ to: number; path: string }>(
      pool,
      `SELECT "to", path FROM rels WHERE "from" = $1`,
      [postSeq],
    )

    // Should have exactly one author rel pointing to user2
    expect(relsResult.rows).toHaveLength(1)
    expect(relsResult.rows[0].to).toBe(user2Id)
    expect(relsResult.rows[0].path).toBe('author')
  })
})


describe('embedding NULL for new/updated docs', () => {
  it('new docs have NULL embedding (indexer will pick them up)', async () => {
    await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Index Me', body: 'Some content' },
    })

    const rows = await query<{ embedding: unknown }>(
      pool,
      `SELECT embedding FROM data WHERE ns = $1 AND type = 'posts'`,
      [ns],
    )

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].embedding).toBeNull()
  })

  it('updated docs keep embedding (adapter does not reset it)', async () => {
    const post = await adapter.create({ ns, type: 'posts', data: { title: 'V1' } })
    await adapter.updateOne({ ns, type: 'posts', id: post.id, data: { title: 'V2' } })

    const rows = await query<{ embedding: unknown }>(
      pool,
      `SELECT embedding FROM data WHERE ns = $1 AND type = 'posts'`,
      [ns],
    )

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].embedding).toBeNull()
  })
})

describe('where compiler against real DB', () => {
  beforeEach(async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'Alpha', status: 'published' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Beta', status: 'draft' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'Gamma', status: 'published' } })
  })

  it('filters by promoted column (status)', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: { status: { equals: 'published' } },
    })
    expect(result.total).toBe(2)
  })

  it('filters by JSON field (title)', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: { title: { equals: 'Beta' } },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Beta')
  })

  it('filters with contains (ILIKE)', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: { title: { contains: 'lph' } },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Alpha')
  })

  it('filters with IN operator', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: { status: { in: ['draft', 'archived'] } },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Beta')
  })

  it('filters with AND', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: {
        and: [
          { status: { equals: 'published' } },
          { title: { contains: 'amma' } },
        ],
      },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Gamma')
  })

  it('filters with OR', async () => {
    const result = await adapter.find({
      ns,
      type: 'posts',
      where: {
        or: [
          { title: { equals: 'Alpha' } },
          { title: { equals: 'Gamma' } },
        ],
      },
    })
    expect(result.total).toBe(2)
  })

  it('pagination with limit and offset', async () => {
    const page1 = await adapter.find({ ns, type: 'posts', limit: 2, offset: 0 })
    const page2 = await adapter.find({ ns, type: 'posts', limit: 2, offset: 2 })

    expect(page1.docs).toHaveLength(2)
    expect(page1.total).toBe(3)
    expect(page2.docs).toHaveLength(1)
    expect(page2.total).toBe(3)
  })
})

describe('namespace resolution', () => {
  it('resolves ns from host', async () => {
    await adapter.nsResolver.refresh()
    const nsDoc = adapter.nsResolver.resolve('test.local')
    expect(nsDoc).not.toBeNull()
    expect(nsDoc!.ns).toBe('test.local')
  })

  it('resolves ns with longest prefix match', async () => {
    await createTestNs('test.local/blog', 'Blog')
    await adapter.nsResolver.refresh()

    const root = adapter.nsResolver.resolve('test.local', '/')
    const blog = adapter.nsResolver.resolve('test.local', '/blog/some-post')

    expect(root!.ns).toBe('test.local')
    expect(blog!.ns).toBe('test.local/blog')
  })

  it('returns null for unknown host', async () => {
    const nsDoc = adapter.nsResolver.resolve('unknown.local')
    expect(nsDoc).toBeNull()
  })

  it('getByNs works', async () => {
    await adapter.nsResolver.refresh()
    const nsDoc = adapter.nsResolver.getByNs('test.local')
    expect(nsDoc).not.toBeNull()
    expect(nsDoc!.ns).toBe('test.local')
  })
})

describe('emit fire-and-forget events', () => {
  it('writes to events table', async () => {
    await adapter.emit({
      ns,
      kind: 'page.viewed',
      meta: { path: '/blog/hello', referrer: 'google.com' },
    })

    const events = await query<{ kind: string; meta: unknown }>(
      pool,
      `SELECT kind, meta FROM events WHERE ns = $1 AND kind = 'page.viewed'`,
      [ns],
    )

    expect(events.rows).toHaveLength(1)
    const meta = events.rows[0].meta as Record<string, unknown>
    expect(meta.path).toBe('/blog/hello')
  })

  it('emit with entity and actor', async () => {
    const post = await adapter.create({ ns, type: 'posts', data: { title: 'Viewed' } })
    const entityId = fromSqid(post.id).seq

    await adapter.emit({
      ns,
      kind: 'ai.generated',
      entity: entityId,
      actor: 99,
      meta: { model: 'gemini-2', tokens: 1200 },
    })

    const events = await query<{ kind: string; entity: number; actor: number }>(
      pool,
      `SELECT kind, entity, actor FROM events WHERE ns = $1 AND kind = 'ai.generated'`,
      [ns],
    )

    expect(events.rows).toHaveLength(1)
    expect(events.rows[0].entity).toBe(entityId)
    expect(events.rows[0].actor).toBe(99)
  })
})

describe('action queue', () => {
  it('enqueue and dequeue', async () => {
    const actionId = await adapter.enqueue({
      ns,
      type: 'job',
      name: 'sendEmail',
      input: { to: 'user@test.com', subject: 'Hello' },
    })

    expect(actionId).toMatch(/^act_/)

    const actions = await adapter.dequeue({ ns, type: 'job', limit: 5 })
    expect(actions).toHaveLength(1)
    expect(actions[0].name).toBe('sendEmail')
    expect(actions[0].status).toBe('running')
    expect(actions[0].started).not.toBeNull()
  })

  it('dequeue respects SKIP LOCKED', async () => {
    await adapter.enqueue({ ns, type: 'job', name: 'job1' })
    await adapter.enqueue({ ns, type: 'job', name: 'job2' })

    // First dequeue takes one
    const batch1 = await adapter.dequeue({ ns, type: 'job', limit: 1 })
    expect(batch1).toHaveLength(1)

    // Second dequeue takes the other
    const batch2 = await adapter.dequeue({ ns, type: 'job', limit: 1 })
    expect(batch2).toHaveLength(1)
    expect(batch2[0].name).not.toBe(batch1[0].name)

    // Third dequeue finds nothing
    const batch3 = await adapter.dequeue({ ns, type: 'job', limit: 1 })
    expect(batch3).toHaveLength(0)
  })

  it('checkpoint saves step result', async () => {
    const actionId = await adapter.enqueue({ ns, type: 'workflow', name: 'multi-step' })
    await adapter.dequeue({ ns, type: 'workflow' })

    await adapter.checkpoint({ id: actionId, step: 1, result: { fetched: true } })

    const action = await query<{ steps: unknown[]; cursor: number }>(
      pool,
      `SELECT steps, cursor FROM actions WHERE seq = $1`,
      [fromSqid(actionId).seq],
    )

    expect(action.rows[0].cursor).toBe(1)
    const steps = action.rows[0].steps
    expect(Array.isArray(steps)).toBe(true)
    expect(steps).toHaveLength(1)
  })

  it('complete marks done', async () => {
    const actionId = await adapter.enqueue({ ns, type: 'job', name: 'complete-me' })
    await adapter.dequeue({ ns, type: 'job' })

    await adapter.complete({ id: actionId, output: { result: 'ok' } })

    const action = await query<{ status: string; output: unknown; completed: Date }>(
      pool,
      `SELECT status, output, completed FROM actions WHERE seq = $1`,
      [fromSqid(actionId).seq],
    )

    expect(action.rows[0].status).toBe('completed')
    expect(action.rows[0].completed).not.toBeNull()
    const output = action.rows[0].output as Record<string, unknown>
    expect(output.result).toBe('ok')
  })

  it('fail with auto-retry when under cap', async () => {
    const actionId = await adapter.enqueue({ ns, type: 'job', name: 'retry-me' })
    await adapter.dequeue({ ns, type: 'job' })

    await adapter.fail({ id: actionId, error: { message: 'Temporary failure' } })

    const action = await query<{ status: string; retries: number }>(
      pool,
      `SELECT status, retries FROM actions WHERE seq = $1`,
      [fromSqid(actionId).seq],
    )

    // Default cap is 3, retries is now 1, so status should be back to pending
    expect(action.rows[0].status).toBe('pending')
    expect(action.rows[0].retries).toBe(1)
  })

  it('fail permanently when at cap', async () => {
    const actionId = await adapter.enqueue({ ns, type: 'job', name: 'fail-me' })

    // Fail 3 times (default cap)
    for (let i = 0; i < 3; i++) {
      await adapter.dequeue({ ns, type: 'job' })
      await adapter.fail({ id: actionId, error: { message: `Failure ${i + 1}` } })
    }

    const action = await query<{ status: string; retries: number }>(
      pool,
      `SELECT status, retries FROM actions WHERE seq = $1`,
      [fromSqid(actionId).seq],
    )

    expect(action.rows[0].status).toBe('failed')
    expect(action.rows[0].retries).toBe(3)
  })

  it('scheduled actions are not dequeued before their time', async () => {
    const future = new Date(Date.now() + 60_000) // 1 minute from now
    await adapter.enqueue({
      ns,
      type: 'job',
      name: 'scheduled',
      scheduled: future,
    })

    const actions = await adapter.dequeue({ ns, type: 'job' })
    expect(actions).toHaveLength(0)
  })
})

describe('COW branching', () => {
  let branchNs: string

  beforeEach(async () => {
    // Create branch namespace
    const branch = await adapter.createBranch({
      parentNs: ns,
      ns: 'test.local/pr/42',
      branch: 'feat/new-hero',
      kind: 'preview',
      ttl: '7 days',
      pr: 42,
    })
    branchNs = branch.ns
    await adapter.nsResolver.refresh()
  })

  it('branch reads inherit from parent', async () => {
    // Create post in parent
    const parentPost = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Parent Post' },
    })

    // find() from branch should see parent's post
    const branchPosts = await adapter.find({
      ns: branchNs,
      type: 'posts',
    })
    expect(branchPosts.total).toBe(1)
    expect(branchPosts.docs[0].title).toBe('Parent Post')

    // findOne by sqid from branch should also see parent's post
    const found = await adapter.findOne({
      ns: branchNs,
      type: 'posts',
      id: parentPost.id,
    })
    expect(found).not.toBeNull()
    expect(found!.title).toBe('Parent Post')

    // findOne by where from branch should see parent's post
    const foundByWhere = await adapter.findOne({
      ns: branchNs,
      type: 'posts',
      where: { title: { equals: 'Parent Post' } },
    })
    expect(foundByWhere).not.toBeNull()
    expect(foundByWhere!.title).toBe('Parent Post')
  })

  it('write in branch forks document (COW)', async () => {
    const parentPost = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Original' },
    })

    // Update in branch
    await adapter.updateOne({
      ns: branchNs,
      type: 'posts',
      id: parentPost.id,
      data: { title: 'Modified in Branch' },
    })

    // Branch sees modified version
    const branchPosts = await adapter.find({ ns: branchNs, type: 'posts' })
    expect(branchPosts.docs[0].title).toBe('Modified in Branch')
    // _parent internal field must not leak to API (find, findOne, updateOne)
    expect(branchPosts.docs[0]._parent).toBeUndefined()

    // findOne by sqid works in branch (even though forked doc has new seq)
    const branchFindOne = await adapter.findOne({ ns: branchNs, type: 'posts', id: parentPost.id })
    expect(branchFindOne).not.toBeNull()
    expect(branchFindOne!.title).toBe('Modified in Branch')
    expect(branchFindOne!._parent).toBeUndefined()

    // Parent still sees original
    const parentPosts = await adapter.find({ ns, type: 'posts' })
    expect(parentPosts.docs[0].title).toBe('Original')
  })

  it('new documents in branch are branch-only', async () => {
    await adapter.create({
      ns: branchNs,
      type: 'posts',
      data: { title: 'Branch Only' },
    })

    const branchPosts = await adapter.find({ ns: branchNs, type: 'posts' })
    expect(branchPosts.total).toBe(1)

    const parentPosts = await adapter.find({ ns, type: 'posts' })
    expect(parentPosts.total).toBe(0)
  })

  it('tombstone: delete in branch does not affect parent', async () => {
    await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'To be hidden' },
    })

    // Delete from branch (writes tombstone)
    await adapter.deleteMany({
      ns: branchNs,
      type: 'posts',
      where: { title: { equals: 'To be hidden' } },
    })

    // Branch should not see it
    const branchPosts = await adapter.find({ ns: branchNs, type: 'posts' })
    expect(branchPosts.total).toBe(0)

    // Parent still sees it
    const parentPosts = await adapter.find({ ns, type: 'posts' })
    expect(parentPosts.total).toBe(1)
  })

  it('merge copies branch changes to parent', async () => {
    const parentPost = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Original' },
    })

    // Modify in branch
    await adapter.updateOne({
      ns: branchNs,
      type: 'posts',
      id: parentPost.id,
      data: { title: 'Merged Change' },
    })

    // Merge branch back
    const mergeResult = await adapter.mergeBranch(branchNs)
    expect(mergeResult.merged).toBe(1)

    // Parent now has the merged change
    const parentPosts = await adapter.find({ ns, type: 'posts' })
    expect(parentPosts.docs[0].title).toBe('Merged Change')
  })
})

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid, toSqid, generateRand } from '../src/id/sqids.js'
import { transaction, query } from '../src/db/pg.js'
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
  const result = await query<{ id: number }>(
    pool,
    `INSERT INTO ns (uri, name, kind, branch) VALUES ('test.local', 'Test', 'production', 'main') RETURNING id`,
  )
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

describe('CRUD lifecycle', () => {
  it('creates a document and returns a sqid', async () => {
    const result = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Hello World', body: 'Content here' },
    })

    expect(result.id).toMatch(/^pos_/)
    expect(result.doc).toEqual({ title: 'Hello World', body: 'Content here' })

    // Verify sqid decodes correctly
    const decoded = fromSqid(result.id)
    expect(decoded.prefix).toBe('pos')
    expect(decoded.id).toBeGreaterThan(0)
  })

  it('finds documents by collection', async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Post 1' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Post 2' } })
    await adapter.create({ ns: nsId, collection: 'users', data: { name: 'User 1' } })

    const posts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(posts.total).toBe(2)
    expect(posts.docs).toHaveLength(2)
    expect(posts.docs[0].id).toMatch(/^pos_/)
  })

  it('finds one document by sqid', async () => {
    const created = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Find Me' },
    })

    const found = await adapter.findOne({
      ns: nsId,
      collection: 'posts',
      id: created.id,
    })

    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.title).toBe('Find Me')
  })

  it('updates a document', async () => {
    const created = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Original', body: 'Original body' },
    })

    const updated = await adapter.updateOne({
      ns: nsId,
      collection: 'posts',
      id: created.id,
      data: { title: 'Updated' },
    })

    expect(updated.id).toBe(created.id)
    const doc = updated.doc as Record<string, unknown>
    expect(doc.title).toBe('Updated')
    expect(doc.body).toBe('Original body') // Merged, not replaced
  })

  it('deletes documents', async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Delete Me', status: 'draft' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Keep Me', status: 'published' } })

    await adapter.deleteMany({
      ns: nsId,
      collection: 'posts',
      where: { status: { equals: 'draft' } },
    })

    const remaining = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(remaining.total).toBe(1)
    expect(remaining.docs[0].title).toBe('Keep Me')
  })
})

describe('sqid encoding through full lifecycle', () => {
  it('sqids are stable across find/findOne', async () => {
    const created = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Stable ID' },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'posts', id: created.id })
    expect(found!.id).toBe(created.id)

    const listed = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(listed.docs[0].id).toBe(created.id)
  })

  it('different collections produce different prefixes', async () => {
    const post = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Post' } })
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'User' } })

    expect(post.id).toMatch(/^pos_/)
    expect(user.id).toMatch(/^usr_/)
  })

  it('sqid round-trips through fromSqid', async () => {
    const created = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Roundtrip' },
    })

    const decoded = fromSqid(created.id)
    expect(decoded.prefix).toBe('pos')
    expect(decoded.ns).toBe(nsId)
    expect(decoded.id).toBeGreaterThan(0)
    expect(decoded.epoch).toBeGreaterThan(0)
  })
})

describe('relationships', () => {
  it('creates and traverses relationships via extractRels', async () => {
    const user = await adapter.create({
      ns: nsId,
      collection: 'users',
      data: { name: 'Author' },
    })
    const userId = fromSqid(user.id).id

    const cat1 = await adapter.create({
      ns: nsId,
      collection: 'categories',
      data: { title: 'Tech' },
    })
    const cat1Id = fromSqid(cat1.id).id

    const cat2 = await adapter.create({
      ns: nsId,
      collection: 'categories',
      data: { title: 'Science' },
    })
    const cat2Id = fromSqid(cat2.id).id

    // Create post with relationships (integer IDs in doc, extractRels resolves them)
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
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
      [nsId],
    )

    expect(relsResult.rows.length).toBe(3) // author + 2 categories
    expect(relsResult.rows.find(r => r.path === 'author')?.to).toBe(userId)
    expect(relsResult.rows.filter(r => r.path.startsWith('categories'))).toHaveLength(2)
  })

  it('relate() and related() work with sqids', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Author' } })
    const post = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Post' } })

    await adapter.relate({ ns: nsId, from: post.id, to: user.id, path: 'reviewer' })

    const related = await adapter.related({ id: post.id, path: 'reviewer', direction: 'from' })
    expect(related).toHaveLength(1)
    expect(related[0].path).toBe('reviewer')
  })

  it('rebuilds rels on update', async () => {
    const user1 = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Author 1' } })
    const user2 = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Author 2' } })
    const user1Id = fromSqid(user1.id).id
    const user2Id = fromSqid(user2.id).id

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Post', author: user1Id },
    })

    // Update to different author
    await adapter.updateOne({
      ns: nsId,
      collection: 'posts',
      id: post.id,
      data: { author: user2Id },
    })

    const postIntId = fromSqid(post.id).id
    const relsResult = await query<{ to: number; path: string }>(
      pool,
      `SELECT "to", path FROM rels WHERE "from" = $1`,
      [postIntId],
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
      ns: nsId,
      collection: 'posts',
      data: { title: 'Index Me', body: 'Some content' },
    })

    const rows = await query<{ embedding: unknown }>(
      pool,
      `SELECT embedding FROM data WHERE ns = $1 AND collection = 'posts'`,
      [nsId],
    )

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].embedding).toBeNull()
  })

  it('updated docs reset embedding to NULL', async () => {
    const post = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'V1' } })
    await adapter.updateOne({ ns: nsId, collection: 'posts', id: post.id, data: { title: 'V2' } })

    const rows = await query<{ embedding: unknown }>(
      pool,
      `SELECT embedding FROM data WHERE ns = $1 AND collection = 'posts'`,
      [nsId],
    )

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].embedding).toBeNull()
  })
})

describe('where compiler against real DB', () => {
  beforeEach(async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Alpha', status: 'published' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Beta', status: 'draft' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Gamma', status: 'published' } })
  })

  it('filters by promoted column (status)', async () => {
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { status: { equals: 'published' } },
    })
    expect(result.total).toBe(2)
  })

  it('filters by JSON field (title)', async () => {
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { title: { equals: 'Beta' } },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Beta')
  })

  it('filters with contains (ILIKE)', async () => {
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { title: { contains: 'lph' } },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Alpha')
  })

  it('filters with IN operator', async () => {
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
      where: { status: { in: ['draft', 'archived'] } },
    })
    expect(result.total).toBe(1)
    expect(result.docs[0].title).toBe('Beta')
  })

  it('filters with AND', async () => {
    const result = await adapter.find({
      ns: nsId,
      collection: 'posts',
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
      ns: nsId,
      collection: 'posts',
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
    const page1 = await adapter.find({ ns: nsId, collection: 'posts', limit: 2, offset: 0 })
    const page2 = await adapter.find({ ns: nsId, collection: 'posts', limit: 2, offset: 2 })

    expect(page1.docs).toHaveLength(2)
    expect(page1.total).toBe(3)
    expect(page2.docs).toHaveLength(1)
    expect(page2.total).toBe(3)
  })
})

describe('namespace resolution', () => {
  it('resolves ns from host', async () => {
    await adapter.nsResolver.refresh()
    const ns = adapter.nsResolver.resolve('test.local')
    expect(ns).not.toBeNull()
    expect(ns!.id).toBe(nsId)
    expect(ns!.uri).toBe('test.local')
  })

  it('resolves ns with longest prefix match', async () => {
    await query(pool, `INSERT INTO ns (uri, name, kind) VALUES ('test.local/blog', 'Blog', 'production')`)
    await adapter.nsResolver.refresh()

    const root = adapter.nsResolver.resolve('test.local', '/')
    const blog = adapter.nsResolver.resolve('test.local', '/blog/some-post')

    expect(root!.uri).toBe('test.local')
    expect(blog!.uri).toBe('test.local/blog')
  })

  it('returns null for unknown host', async () => {
    const ns = adapter.nsResolver.resolve('unknown.local')
    expect(ns).toBeNull()
  })

  it('getById works', async () => {
    await adapter.nsResolver.refresh()
    const ns = adapter.nsResolver.getById(nsId)
    expect(ns).not.toBeNull()
    expect(ns!.uri).toBe('test.local')
  })
})

describe('emit fire-and-forget events', () => {
  it('writes to events table', async () => {
    await adapter.emit({
      ns: nsId,
      kind: 'page.viewed',
      meta: { path: '/blog/hello', referrer: 'google.com' },
    })

    const events = await query<{ kind: string; meta: unknown }>(
      pool,
      `SELECT kind, meta FROM events WHERE ns = $1 AND kind = 'page.viewed'`,
      [nsId],
    )

    expect(events.rows).toHaveLength(1)
    const meta = events.rows[0].meta as Record<string, unknown>
    expect(meta.path).toBe('/blog/hello')
  })

  it('emit with entity and actor', async () => {
    const post = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Viewed' } })
    const entityId = fromSqid(post.id).id

    await adapter.emit({
      ns: nsId,
      kind: 'ai.generated',
      entity: entityId,
      actor: 99,
      meta: { model: 'gemini-2', tokens: 1200 },
    })

    const events = await query<{ kind: string; entity: number; actor: number }>(
      pool,
      `SELECT kind, entity, actor FROM events WHERE ns = $1 AND kind = 'ai.generated'`,
      [nsId],
    )

    expect(events.rows).toHaveLength(1)
    expect(events.rows[0].entity).toBe(entityId)
    expect(events.rows[0].actor).toBe(99)
  })
})

describe('action queue', () => {
  it('enqueue and dequeue', async () => {
    const actionId = await adapter.enqueue({
      ns: nsId,
      kind: 'job',
      name: 'sendEmail',
      input: { to: 'user@test.com', subject: 'Hello' },
    })

    expect(actionId).toMatch(/^act_/)

    const actions = await adapter.dequeue({ ns: nsId, kind: 'job', limit: 5 })
    expect(actions).toHaveLength(1)
    expect(actions[0].name).toBe('sendEmail')
    expect(actions[0].status).toBe('running')
    expect(actions[0].started).not.toBeNull()
  })

  it('dequeue respects SKIP LOCKED', async () => {
    await adapter.enqueue({ ns: nsId, kind: 'job', name: 'job1' })
    await adapter.enqueue({ ns: nsId, kind: 'job', name: 'job2' })

    // First dequeue takes one
    const batch1 = await adapter.dequeue({ ns: nsId, kind: 'job', limit: 1 })
    expect(batch1).toHaveLength(1)

    // Second dequeue takes the other
    const batch2 = await adapter.dequeue({ ns: nsId, kind: 'job', limit: 1 })
    expect(batch2).toHaveLength(1)
    expect(batch2[0].name).not.toBe(batch1[0].name)

    // Third dequeue finds nothing
    const batch3 = await adapter.dequeue({ ns: nsId, kind: 'job', limit: 1 })
    expect(batch3).toHaveLength(0)
  })

  it('checkpoint saves step result', async () => {
    const actionId = await adapter.enqueue({ ns: nsId, kind: 'workflow', name: 'multi-step' })
    await adapter.dequeue({ ns: nsId, kind: 'workflow' })

    await adapter.checkpoint({ id: actionId, step: 1, result: { fetched: true } })

    const action = await query<{ steps: unknown[]; cursor: number }>(
      pool,
      `SELECT steps, cursor FROM actions WHERE id = $1`,
      [fromSqid(actionId).id],
    )

    expect(action.rows[0].cursor).toBe(1)
    const steps = action.rows[0].steps
    expect(Array.isArray(steps)).toBe(true)
    expect(steps).toHaveLength(1)
  })

  it('complete marks done', async () => {
    const actionId = await adapter.enqueue({ ns: nsId, kind: 'job', name: 'complete-me' })
    await adapter.dequeue({ ns: nsId, kind: 'job' })

    await adapter.complete({ id: actionId, output: { result: 'ok' } })

    const action = await query<{ status: string; output: unknown; completed: Date }>(
      pool,
      `SELECT status, output, completed FROM actions WHERE id = $1`,
      [fromSqid(actionId).id],
    )

    expect(action.rows[0].status).toBe('completed')
    expect(action.rows[0].completed).not.toBeNull()
    const output = action.rows[0].output as Record<string, unknown>
    expect(output.result).toBe('ok')
  })

  it('fail with auto-retry when under cap', async () => {
    const actionId = await adapter.enqueue({ ns: nsId, kind: 'job', name: 'retry-me' })
    await adapter.dequeue({ ns: nsId, kind: 'job' })

    await adapter.fail({ id: actionId, error: { message: 'Temporary failure' } })

    const action = await query<{ status: string; retries: number }>(
      pool,
      `SELECT status, retries FROM actions WHERE id = $1`,
      [fromSqid(actionId).id],
    )

    // Default cap is 3, retries is now 1, so status should be back to pending
    expect(action.rows[0].status).toBe('pending')
    expect(action.rows[0].retries).toBe(1)
  })

  it('fail permanently when at cap', async () => {
    const actionId = await adapter.enqueue({ ns: nsId, kind: 'job', name: 'fail-me' })

    // Fail 3 times (default cap)
    for (let i = 0; i < 3; i++) {
      await adapter.dequeue({ ns: nsId, kind: 'job' })
      await adapter.fail({ id: actionId, error: { message: `Failure ${i + 1}` } })
    }

    const action = await query<{ status: string; retries: number }>(
      pool,
      `SELECT status, retries FROM actions WHERE id = $1`,
      [fromSqid(actionId).id],
    )

    expect(action.rows[0].status).toBe('failed')
    expect(action.rows[0].retries).toBe(3)
  })

  it('scheduled actions are not dequeued before their time', async () => {
    const future = new Date(Date.now() + 60_000) // 1 minute from now
    await adapter.enqueue({
      ns: nsId,
      kind: 'job',
      name: 'scheduled',
      scheduled: future,
    })

    const actions = await adapter.dequeue({ ns: nsId, kind: 'job' })
    expect(actions).toHaveLength(0)
  })
})

describe('COW branching', () => {
  let branchNsId: number

  beforeEach(async () => {
    // Create branch namespace
    const branchNs = await adapter.createBranch({
      parent: nsId,
      uri: 'test.local/pr/42',
      branch: 'feat/new-hero',
      kind: 'preview',
      ttl: '7 days',
      pr: 42,
    })
    branchNsId = branchNs.id
    await adapter.nsResolver.refresh()
  })

  it('branch reads inherit from parent', async () => {
    // Create post in parent
    const parentPost = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Parent Post' },
    })

    // find() from branch should see parent's post
    const branchPosts = await adapter.find({
      ns: branchNsId,
      collection: 'posts',
    })
    expect(branchPosts.total).toBe(1)
    expect(branchPosts.docs[0].title).toBe('Parent Post')

    // findOne by sqid from branch should also see parent's post
    const found = await adapter.findOne({
      ns: branchNsId,
      collection: 'posts',
      id: parentPost.id,
    })
    expect(found).not.toBeNull()
    expect(found!.title).toBe('Parent Post')

    // findOne by where from branch should see parent's post
    const foundByWhere = await adapter.findOne({
      ns: branchNsId,
      collection: 'posts',
      where: { title: { equals: 'Parent Post' } },
    })
    expect(foundByWhere).not.toBeNull()
    expect(foundByWhere!.title).toBe('Parent Post')
  })

  it('write in branch forks document (COW)', async () => {
    const parentPost = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Original' },
    })

    // Update in branch
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: parentPost.id,
      data: { title: 'Modified in Branch' },
    })

    // Branch sees modified version
    const branchPosts = await adapter.find({ ns: branchNsId, collection: 'posts' })
    expect(branchPosts.docs[0].title).toBe('Modified in Branch')
    // _parent internal field must not leak to API (find, findOne, updateOne)
    expect(branchPosts.docs[0]._parent).toBeUndefined()

    // findOne by sqid works in branch (even though forked doc has new id)
    const branchFindOne = await adapter.findOne({ ns: branchNsId, collection: 'posts', id: parentPost.id })
    expect(branchFindOne).not.toBeNull()
    expect(branchFindOne!.title).toBe('Modified in Branch')
    expect(branchFindOne!._parent).toBeUndefined()

    // Parent still sees original
    const parentPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(parentPosts.docs[0].title).toBe('Original')
  })

  it('new documents in branch are branch-only', async () => {
    await adapter.create({
      ns: branchNsId,
      collection: 'posts',
      data: { title: 'Branch Only' },
    })

    const branchPosts = await adapter.find({ ns: branchNsId, collection: 'posts' })
    expect(branchPosts.total).toBe(1)

    const parentPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(parentPosts.total).toBe(0)
  })

  it('tombstone: delete in branch does not affect parent', async () => {
    await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'To be hidden' },
    })

    // Delete from branch (writes tombstone)
    await adapter.deleteMany({
      ns: branchNsId,
      collection: 'posts',
      where: { title: { equals: 'To be hidden' } },
    })

    // Branch should not see it
    const branchPosts = await adapter.find({ ns: branchNsId, collection: 'posts' })
    expect(branchPosts.total).toBe(0)

    // Parent still sees it
    const parentPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(parentPosts.total).toBe(1)
  })

  it('merge copies branch changes to parent', async () => {
    const parentPost = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Original' },
    })

    // Modify in branch
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: parentPost.id,
      data: { title: 'Merged Change' },
    })

    // Merge branch back
    const mergeResult = await adapter.mergeBranch(branchNsId)
    expect(mergeResult.merged).toBe(1)

    // Parent now has the merged change
    const parentPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(parentPosts.docs[0].title).toBe('Merged Change')
  })
})

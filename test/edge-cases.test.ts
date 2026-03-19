import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query, transaction } from '../src/db/pg.js'
import { insertData } from '../src/db/queries/data.js'
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
        { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
        {
          name: 'blocks',
          type: 'array',
          fields: [
            { name: 'ref', type: 'relationship', relationTo: 'media' },
          ],
        },
      ],
    },
    { slug: 'users', prefix: 'usr', fields: [{ name: 'name', type: 'text' }] },
    { slug: 'tags', prefix: 'tag', fields: [{ name: 'label', type: 'text' }] },
    { slug: 'media', prefix: 'med', fields: [{ name: 'url', type: 'text' }] },
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
    `INSERT INTO ns (uri, name, kind, branch) VALUES ('edge.test', 'Edge', 'production', 'main') RETURNING id`,
  )
  nsId = result.rows[0].id
  await adapter.nsResolver.refresh()
})

describe('complex document structures', () => {
  it('handles deeply nested JSON documents', async () => {
    const complex = {
      title: 'Complex',
      meta: {
        seo: { title: 'SEO Title', description: 'Desc' },
        og: { image: 'img.png' },
      },
      blocks: [
        { type: 'hero', content: { heading: 'Hello', subheading: 'World' } },
        { type: 'text', content: { body: 'Paragraph here' } },
      ],
    }

    const created = await adapter.create({ ns: nsId, collection: 'posts', data: complex })
    const found = await adapter.findOne({ ns: nsId, collection: 'posts', id: created.id })

    expect(found).not.toBeNull()
    const doc = found as Record<string, unknown>
    const meta = doc.meta as Record<string, unknown>
    const seo = meta.seo as Record<string, unknown>
    expect(seo.title).toBe('SEO Title')
  })

  it('handles empty document', async () => {
    const created = await adapter.create({ ns: nsId, collection: 'posts', data: {} })
    expect(created.id).toMatch(/^pos_/)

    const found = await adapter.findOne({ ns: nsId, collection: 'posts', id: created.id })
    expect(found).not.toBeNull()
  })

  it('handles special characters in string values', async () => {
    const created = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: {
        title: "It's a test with \"quotes\" and <html> & unicode: 日本語 🎉",
        body: 'Line 1\nLine 2\tTabbed',
      },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'posts', id: created.id })
    expect(found!.title).toBe("It's a test with \"quotes\" and <html> & unicode: 日本語 🎉")
  })

  it('handles large documents', async () => {
    const largeBody = 'x'.repeat(100_000)
    const created = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Large', body: largeBody },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'posts', id: created.id })
    expect((found!.body as string).length).toBe(100_000)
  })

  it('handles null and missing fields', async () => {
    const created = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: null, body: undefined, status: null },
    })

    const found = await adapter.findOne({ ns: nsId, collection: 'posts', id: created.id })
    expect(found!.title).toBeNull()
  })
})

describe('relationship edge cases', () => {
  it('handles many relationships', async () => {
    // Create 20 tags
    const tagIds: number[] = []
    for (let i = 0; i < 20; i++) {
      const tag = await adapter.create({
        ns: nsId,
        collection: 'tags',
        data: { label: `Tag ${i}` },
      })
      tagIds.push(fromSqid(tag.id).id)
    }

    // Create post with all 20 tags
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Many Tags', tags: tagIds },
    })

    // Verify all rels created
    const rels = await query<{ path: string }>(
      pool,
      `SELECT path FROM rels WHERE "from" = $1 ORDER BY sort`,
      [fromSqid(post.id).id],
    )
    expect(rels.rows).toHaveLength(20)
    expect(rels.rows[0].path).toBe('tags.0')
    expect(rels.rows[19].path).toBe('tags.19')
  })

  it('handles nested array relationships', async () => {
    const media1 = await adapter.create({ ns: nsId, collection: 'media', data: { url: 'img1.png' } })
    const media2 = await adapter.create({ ns: nsId, collection: 'media', data: { url: 'img2.png' } })

    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: {
        title: 'With blocks',
        blocks: [
          { ref: fromSqid(media1.id).id },
          { ref: fromSqid(media2.id).id },
        ],
      },
    })

    const rels = await query<{ path: string; to: number }>(
      pool,
      `SELECT path, "to" FROM rels WHERE "from" = $1 ORDER BY path`,
      [fromSqid(post.id).id],
    )
    expect(rels.rows).toHaveLength(2)
    expect(rels.rows[0].path).toBe('blocks.0.ref')
    expect(rels.rows[1].path).toBe('blocks.1.ref')
  })

  it('handles no relationships gracefully', async () => {
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'No rels' },
    })

    const related = await adapter.related({ id: post.id })
    expect(related).toHaveLength(0)
  })
})

describe('concurrent operations', () => {
  it('handles concurrent creates', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      adapter.create({
        ns: nsId,
        collection: 'posts',
        data: { title: `Concurrent ${i}` },
      }),
    )

    const results = await Promise.all(promises)
    expect(results).toHaveLength(10)

    // All should have unique IDs
    const ids = new Set(results.map(r => r.id))
    expect(ids.size).toBe(10)

    // All should be findable
    const all = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(all.total).toBe(10)
  })

  it('handles concurrent action dequeues', async () => {
    // Enqueue 5 actions
    for (let i = 0; i < 5; i++) {
      await adapter.enqueue({ ns: nsId, kind: 'job', name: `job-${i}` })
    }

    // Dequeue concurrently from 3 workers
    const [batch1, batch2, batch3] = await Promise.all([
      adapter.dequeue({ ns: nsId, kind: 'job', limit: 2 }),
      adapter.dequeue({ ns: nsId, kind: 'job', limit: 2 }),
      adapter.dequeue({ ns: nsId, kind: 'job', limit: 2 }),
    ])

    // Total dequeued should be 5 (SKIP LOCKED prevents double-dequeue)
    const totalDequeued = batch1.length + batch2.length + batch3.length
    expect(totalDequeued).toBe(5)

    // No duplicates
    const allNames = [...batch1, ...batch2, ...batch3].map(a => a.name)
    expect(new Set(allNames).size).toBe(5)
  })
})

describe('COW edge cases', () => {
  let branchNsId: number

  beforeEach(async () => {
    const branchNs = await adapter.createBranch({
      parent: nsId,
      uri: 'edge.test/pr/1',
      branch: 'feat/edge',
      kind: 'preview',
    })
    branchNsId = branchNs.id
    await adapter.nsResolver.refresh()
  })

  it('branch with multiple parent docs', async () => {
    // Create 3 docs in parent
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'P1' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'P2' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'P3' } })

    // Branch should see all 3
    const branchPosts = await adapter.find({ ns: branchNsId, collection: 'posts' })
    expect(branchPosts.total).toBe(3)
  })

  it('branch modifies one parent doc, rest inherited', async () => {
    const p1 = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'P1' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'P2' } })
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'P3' } })

    // Modify P1 in branch
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: p1.id,
      data: { title: 'P1 Modified' },
    })

    // Branch sees 3 docs total (1 modified + 2 inherited)
    const branchPosts = await adapter.find({ ns: branchNsId, collection: 'posts' })
    expect(branchPosts.total).toBe(3)

    const titles = branchPosts.docs.map(d => d.title).sort()
    expect(titles).toContain('P1 Modified')
    expect(titles).toContain('P2')
    expect(titles).toContain('P3')
  })

  it('branch creates new doc + inherits parent docs', async () => {
    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Parent' } })
    await adapter.create({ ns: branchNsId, collection: 'posts', data: { title: 'Branch New' } })

    const branchPosts = await adapter.find({ ns: branchNsId, collection: 'posts' })
    expect(branchPosts.total).toBe(2)
  })

  it('merge with new + modified + tombstoned docs', async () => {
    // Create parent docs
    const p1 = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Keep' } })
    const p2 = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Modify' } })
    const p3 = await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'Delete' } })

    // In branch: modify P2, delete P3, create new
    await adapter.updateOne({
      ns: branchNsId,
      collection: 'posts',
      id: p2.id,
      data: { title: 'Modified' },
    })
    await adapter.deleteMany({
      ns: branchNsId,
      collection: 'posts',
      where: { title: { equals: 'Delete' } },
    })
    await adapter.create({ ns: branchNsId, collection: 'posts', data: { title: 'New' } })

    // Merge
    const result = await adapter.mergeBranch(branchNsId)
    expect(result.merged).toBeGreaterThan(0)
    expect(result.deleted).toBe(1)

    // Parent should have: Keep, Modified, New (3 docs, Delete is gone)
    const parentPosts = await adapter.find({ ns: nsId, collection: 'posts' })
    const titles = parentPosts.docs.map(d => d.title).sort()
    expect(titles).toContain('Keep')
    expect(titles).toContain('Modified')
    expect(titles).toContain('New')
    expect(titles).not.toContain('Delete')
  })
})

describe('namespace isolation', () => {
  it('documents are isolated between namespaces', async () => {
    const ns2Result = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('other.test', 'Other', 'production') RETURNING id`,
    )
    const ns2Id = ns2Result.rows[0].id
    await adapter.nsResolver.refresh()

    await adapter.create({ ns: nsId, collection: 'posts', data: { title: 'NS1 Post' } })
    await adapter.create({ ns: ns2Id, collection: 'posts', data: { title: 'NS2 Post' } })

    const ns1Posts = await adapter.find({ ns: nsId, collection: 'posts' })
    expect(ns1Posts.total).toBe(1)
    expect(ns1Posts.docs[0].title).toBe('NS1 Post')

    const ns2Posts = await adapter.find({ ns: ns2Id, collection: 'posts' })
    expect(ns2Posts.total).toBe(1)
    expect(ns2Posts.docs[0].title).toBe('NS2 Post')
  })

  it('rels are scoped to namespace', async () => {
    const user = await adapter.create({ ns: nsId, collection: 'users', data: { name: 'Author' } })
    const post = await adapter.create({
      ns: nsId,
      collection: 'posts',
      data: { title: 'Post', author: fromSqid(user.id).id },
    })

    // Create another namespace
    const ns2Result = await query<{ id: number }>(
      pool,
      `INSERT INTO ns (uri, name, kind) VALUES ('other2.test', 'Other2', 'production') RETURNING id`,
    )
    await adapter.nsResolver.refresh()

    // Rels query should be scoped
    const rels = await query<{ ns: number }>(
      pool,
      `SELECT ns FROM rels WHERE "from" = $1`,
      [fromSqid(post.id).id],
    )
    expect(rels.rows.every(r => r.ns === nsId)).toBe(true)
  })
})

describe('tier classification', () => {
  it('classifies PG collections', () => {
    expect(adapter.tier('posts')).toBe('pg')
    expect(adapter.tier('users')).toBe('pg')
    expect(adapter.tier('anything')).toBe('pg')
  })

  it('classifies CH collections', () => {
    expect(adapter.tier('events')).toBe('ch')
    expect(adapter.tier('versions')).toBe('ch')
    expect(adapter.tier('search')).toBe('ch')
  })
})

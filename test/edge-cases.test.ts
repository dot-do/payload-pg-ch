import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupTestSchema, cleanupTestData, createTestNs, teardownTestPool } from './setup.js'
import { DocumentAdapter } from '../src/adapter.js'
import { fromSqid } from '../src/id/sqids.js'
import { query, transaction } from '../src/db/pg.js'
import { insertData } from '../src/db/queries/data.js'
import type pg from 'pg'

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:test@localhost:5433/testdb'

let adapter: DocumentAdapter
let pool: pg.Pool
let ns: string

beforeAll(async () => {
  pool = getTestPool() as unknown as pg.Pool
  await setupTestSchema()

  adapter = new DocumentAdapter({ postgres: TEST_DB, ns: 'edge.test' }, [
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
  ns = await createTestNs('edge.test', 'Edge')
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

    const created = await adapter.create({ ns, type: 'posts', data: complex })
    const found = await adapter.findOne({ ns, type: 'posts', id: created.id })

    expect(found).not.toBeNull()
    const doc = found as Record<string, unknown>
    const m = doc.meta as Record<string, unknown>
    const seo = m.seo as Record<string, unknown>
    expect(seo.title).toBe('SEO Title')
  })

  it('handles empty document', async () => {
    const created = await adapter.create({ ns, type: 'posts', data: {} })
    expect(created.id).toMatch(/^pos_/)

    const found = await adapter.findOne({ ns, type: 'posts', id: created.id })
    expect(found).not.toBeNull()
  })

  it('handles special characters in string values', async () => {
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: {
        title: "It's a test with \"quotes\" and <html> & unicode: \u65E5\u672C\u8A9E",
        body: 'Line 1\nLine 2\tTabbed',
      },
    })

    const found = await adapter.findOne({ ns, type: 'posts', id: created.id })
    expect(found!.title).toBe("It's a test with \"quotes\" and <html> & unicode: \u65E5\u672C\u8A9E")
  })

  it('handles large documents', async () => {
    const largeBody = 'x'.repeat(100_000)
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Large', body: largeBody },
    })

    const found = await adapter.findOne({ ns, type: 'posts', id: created.id })
    expect((found!.body as string).length).toBe(100_000)
  })

  it('handles null and missing fields', async () => {
    const created = await adapter.create({
      ns,
      type: 'posts',
      data: { title: null, body: undefined, status: null },
    })

    const found = await adapter.findOne({ ns, type: 'posts', id: created.id })
    expect(found!.title).toBeNull()
  })
})

describe('relationship edge cases', () => {
  it('handles many relationships', async () => {
    const tagIds: number[] = []
    for (let i = 0; i < 20; i++) {
      const tag = await adapter.create({
        ns,
        type: 'tags',
        data: { label: `Tag ${i}` },
      })
      tagIds.push(fromSqid(tag.id).seq)
    }

    const post = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Many Tags', tags: tagIds },
    })

    const rels = await query<{ path: string }>(
      pool,
      `SELECT path FROM rels WHERE "from" = $1 ORDER BY sort`,
      [fromSqid(post.id).seq],
    )
    expect(rels.rows).toHaveLength(20)
    expect(rels.rows[0].path).toBe('tags.0')
    expect(rels.rows[19].path).toBe('tags.19')
  })

  it('handles nested array relationships', async () => {
    const media1 = await adapter.create({ ns, type: 'media', data: { url: 'img1.png' } })
    const media2 = await adapter.create({ ns, type: 'media', data: { url: 'img2.png' } })

    const post = await adapter.create({
      ns,
      type: 'posts',
      data: {
        title: 'With blocks',
        blocks: [
          { ref: fromSqid(media1.id).seq },
          { ref: fromSqid(media2.id).seq },
        ],
      },
    })

    const rels = await query<{ path: string; to: number }>(
      pool,
      `SELECT path, "to" FROM rels WHERE "from" = $1 ORDER BY path`,
      [fromSqid(post.id).seq],
    )
    expect(rels.rows).toHaveLength(2)
    expect(rels.rows[0].path).toBe('blocks.0.ref')
    expect(rels.rows[1].path).toBe('blocks.1.ref')
  })

  it('handles no relationships gracefully', async () => {
    const post = await adapter.create({
      ns,
      type: 'posts',
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
        ns,
        type: 'posts',
        data: { title: `Concurrent ${i}` },
      }),
    )

    const results = await Promise.all(promises)
    expect(results).toHaveLength(10)

    const ids = new Set(results.map(r => r.id))
    expect(ids.size).toBe(10)

    const all = await adapter.find({ ns, type: 'posts' })
    expect(all.total).toBe(10)
  })

  it('handles concurrent action dequeues', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.enqueue({ ns, type: 'job', name: `job-${i}` })
    }

    const [batch1, batch2, batch3] = await Promise.all([
      adapter.dequeue({ ns, type: 'job', limit: 2 }),
      adapter.dequeue({ ns, type: 'job', limit: 2 }),
      adapter.dequeue({ ns, type: 'job', limit: 2 }),
    ])

    const totalDequeued = batch1.length + batch2.length + batch3.length
    expect(totalDequeued).toBe(5)

    const allNames = [...batch1, ...batch2, ...batch3].map(a => a.name)
    expect(new Set(allNames).size).toBe(5)
  })
})

describe('COW edge cases', () => {
  let branchNs: string

  beforeEach(async () => {
    const branch = await adapter.createBranch({
      parentNs: ns,
      ns: 'edge.test/pr/1',
      branch: 'feat/edge',
      kind: 'preview',
    })
    branchNs = branch.ns
    await adapter.nsResolver.refresh()
  })

  it('branch with multiple parent docs', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'P1' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'P2' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'P3' } })

    const branchPosts = await adapter.find({ ns: branchNs, type: 'posts' })
    expect(branchPosts.total).toBe(3)
  })

  it('branch modifies one parent doc, rest inherited', async () => {
    const p1 = await adapter.create({ ns, type: 'posts', data: { title: 'P1' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'P2' } })
    await adapter.create({ ns, type: 'posts', data: { title: 'P3' } })

    await adapter.updateOne({
      ns: branchNs,
      type: 'posts',
      id: p1.id,
      data: { title: 'P1 Modified' },
    })

    const branchPosts = await adapter.find({ ns: branchNs, type: 'posts' })
    expect(branchPosts.total).toBe(3)

    const titles = branchPosts.docs.map(d => d.title).sort()
    expect(titles).toContain('P1 Modified')
    expect(titles).toContain('P2')
    expect(titles).toContain('P3')
  })

  it('branch creates new doc + inherits parent docs', async () => {
    await adapter.create({ ns, type: 'posts', data: { title: 'Parent' } })
    await adapter.create({ ns: branchNs, type: 'posts', data: { title: 'Branch New' } })

    const branchPosts = await adapter.find({ ns: branchNs, type: 'posts' })
    expect(branchPosts.total).toBe(2)
  })

  it('merge with new + modified + tombstoned docs', async () => {
    const p1 = await adapter.create({ ns, type: 'posts', data: { title: 'Keep' } })
    const p2 = await adapter.create({ ns, type: 'posts', data: { title: 'Modify' } })
    const p3 = await adapter.create({ ns, type: 'posts', data: { title: 'Delete' } })

    await adapter.updateOne({
      ns: branchNs,
      type: 'posts',
      id: p2.id,
      data: { title: 'Modified' },
    })
    await adapter.deleteMany({
      ns: branchNs,
      type: 'posts',
      where: { title: { equals: 'Delete' } },
    })
    await adapter.create({ ns: branchNs, type: 'posts', data: { title: 'New' } })

    const result = await adapter.mergeBranch(branchNs)
    expect(result.merged).toBeGreaterThan(0)
    expect(result.deleted).toBe(1)

    const parentPosts = await adapter.find({ ns, type: 'posts' })
    const titles = parentPosts.docs.map(d => d.title).sort()
    expect(titles).toContain('Keep')
    expect(titles).toContain('Modified')
    expect(titles).toContain('New')
    expect(titles).not.toContain('Delete')
  })
})

describe('namespace isolation', () => {
  it('documents are isolated between namespaces', async () => {
    const ns2 = await createTestNs('other.test', 'Other')
    await adapter.nsResolver.refresh()

    await adapter.create({ ns, type: 'posts', data: { title: 'NS1 Post' } })
    await adapter.create({ ns: ns2, type: 'posts', data: { title: 'NS2 Post' } })

    const ns1Posts = await adapter.find({ ns, type: 'posts' })
    expect(ns1Posts.total).toBe(1)
    expect(ns1Posts.docs[0].title).toBe('NS1 Post')

    const ns2Posts = await adapter.find({ ns: ns2, type: 'posts' })
    expect(ns2Posts.total).toBe(1)
    expect(ns2Posts.docs[0].title).toBe('NS2 Post')
  })

  it('rels are scoped to namespace', async () => {
    const user = await adapter.create({ ns, type: 'users', data: { name: 'Author' } })
    const post = await adapter.create({
      ns,
      type: 'posts',
      data: { title: 'Post', author: fromSqid(user.id).seq },
    })

    await createTestNs('other2.test', 'Other2')
    await adapter.nsResolver.refresh()

    const rels = await query<{ ns: string }>(
      pool,
      `SELECT ns FROM rels WHERE "from" = $1`,
      [fromSqid(post.id).seq],
    )
    expect(rels.rows.every(r => r.ns === ns)).toBe(true)
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
